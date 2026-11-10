/**
 * 本地「假 Supabase」：用 PGlite（WASM 版真 Postgres）跑 schema.sql，
 * 再用 Node 内置 http 复刻 Supabase 用到的三条路径：
 *
 *   POST /auth/v1/signup                注册（模拟已关闭邮箱确认）
 *   POST /auth/v1/token?grant_type=…    登录 / 刷新令牌
 *   /rest/v1/<表>?<PostgREST 查询>       表的增删改查（含行级权限）
 *   POST /rest/v1/rpc/<函数>            调用建家 / 邀请码入家
 *
 * 目的：让 src/store.js 的 RemoteStore 和 src/supabase.js 用**真实代码路径**
 * 跑在真 Postgres 上，验证查询参数、写入、RLS 是不是真的按预期工作。
 *
 * 注意：只在开发机上用，需要临时装 PGlite，不进 package.json。
 *   npm i --no-save @electric-sql/pglite
 */

import { PGlite } from '@electric-sql/pglite';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const SCHEMA_PATH = new URL('../../supabase/schema.sql', import.meta.url);

/* ---------------- 小工具 ---------------- */

function sendJson(res, status, payload) {
  const body = payload === undefined ? '' : JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendEmpty(res, status = 204) {
  res.writeHead(status, { 'Content-Length': 0 });
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(null);
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

/** SQL 字面量：所有值都当 unknown 字面量给 Postgres，让它自己往列类型上转 */
function lit(value) {
  if (value === null || value === undefined) return 'NULL';
  if (Array.isArray(value)) {
    if (!value.length) return `ARRAY[]::text[]`;
    return `ARRAY[${value.map((v) => lit(v)).join(', ')}]::text[]`;
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

function ident(name) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`非法列名：${name}`);
  return `"${name}"`;
}

/** Supabase（PostgREST）单次响应最多给这么多行，超出的静默截断 */
const MAX_ROWS = Number(process.env.FAKE_SUPABASE_MAX_ROWS || 1000);

/** PostgREST 的过滤语法 → SQL 条件 */
function buildWhere(params) {  const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns']);
  const parts = [];

  const one = (column, expr) => {
    const [op, ...rest] = String(expr).split('.');
    const value = rest.join('.');
    switch (op) {
      case 'eq':
        return `${ident(column)} = ${lit(value === 'null' ? null : value)}`;
      case 'neq':
        return `${ident(column)} <> ${lit(value)}`;
      case 'gt':
        return `${ident(column)} > ${lit(value)}`;
      case 'gte':
        return `${ident(column)} >= ${lit(value)}`;
      case 'lt':
        return `${ident(column)} < ${lit(value)}`;
      case 'lte':
        return `${ident(column)} <= ${lit(value)}`;
      case 'is':
        if (value === 'null') return `${ident(column)} is null`;
        if (value === 'true' || value === 'false') return `${ident(column)} is ${value}`;
        throw new Error(`不支持的 is 用法：${expr}`);
      case 'in': {
        const list = value.replace(/^\(|\)$/g, '').split(',').filter((s) => s !== '');
        return `${ident(column)} in (${list.map((v) => lit(v)).join(', ')})`;
      }
      default:
        throw new Error(`不支持的过滤运算符：${op}`);
    }
  };

  for (const [key, raw] of params) {
    if (RESERVED.has(key)) continue;
    if (key === 'and') {
      const inner = String(raw).replace(/^\(|\)$/g, '');
      const conds = inner.split(',').filter(Boolean).map((item) => {
        const [col, ...rest] = item.split('.');
        return one(col, rest.join('.'));
      });
      if (conds.length) parts.push(`(${conds.join(' and ')})`);
      continue;
    }
    if (key === 'or') {
      const inner = String(raw).replace(/^\(|\)$/g, '');
      const conds = inner.split(',').filter(Boolean).map((item) => {
        const [col, ...rest] = item.split('.');
        return one(col, rest.join('.'));
      });
      if (conds.length) parts.push(`(${conds.join(' or ')})`);
      continue;
    }
    parts.push(one(key, raw));
  }

  return parts.length ? ` where ${parts.join(' and ')}` : '';
}

function buildOrder(order) {
  if (!order) return '';
  const items = String(order)
    .split(',')
    .map((chunk) => {
      const [col, dir] = chunk.split('.');
      const direction = String(dir || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
      return `${ident(col)} ${direction}`;
    });
  return ` order by ${items.join(', ')}`;
}

function buildColumns(select) {
  if (!select || select === '*') return '*';
  return String(select)
    .split(',')
    .map((c) => (c.trim() === '*' ? '*' : ident(c.trim())))
    .join(', ');
}

/* ---------------- 主流程 ---------------- */

export async function startFakeSupabase({ silent = true } = {}) {
  const db = await PGlite.create();

  // ---- 伪造 Supabase 的 auth 环境 ----
  await db.exec(`
    create schema if not exists auth;
    create table if not exists auth.users (
      id uuid primary key default gen_random_uuid(),
      email text unique
    );
    create or replace function auth.uid() returns uuid
    language sql stable as $$
      select nullif(current_setting('test.uid', true), '')::uuid
    $$;
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
    end $$;
  `);

  const schemaSql = readFileSync(SCHEMA_PATH, 'utf8');
  try {
    await db.exec(schemaSql);
  } catch (err) {
    if (!/pgcrypto/i.test(err.message)) throw err;
    await db.exec(schemaSql.replace(/create extension[^;]*pgcrypto[^;]*;/i, ''));
  }

  // Supabase 默认会给 anon/authenticated 表权限，这里补上
  await db.exec(`
    grant usage on schema public to anon, authenticated;
    grant usage on schema auth to anon, authenticated;
    grant all on all tables in schema public to anon, authenticated;
    grant all on all sequences in schema public to anon, authenticated;
    grant select on auth.users to anon, authenticated;
  `);

  const usersByEmail = new Map(); // email -> { id, password }
  const tokens = new Map(); // token -> uid
  const ANON_KEY = 'fake-anon-key';

  function issueTokens(email) {
    const user = usersByEmail.get(email);
    const access = `acc_${randomUUID()}`;
    const refresh = `ref_${randomUUID()}`;
    tokens.set(access, user.id);
    tokens.set(refresh, user.id);
    return {
      access_token: access,
      refresh_token: refresh,
      token_type: 'bearer',
      expires_in: 3600,
      user: { id: user.id, email },
    };
  }

  /**
   * 和真 PostgREST 一致：anon key 合法（以匿名身份放行），
   * 但**认不出来的 Bearer token 要返回 401**（真服务就是这样，不会当成匿名用户放过去）。
   */
  function tokenInfo(req) {
    const auth = req.headers.authorization || '';
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    if (!token || token === ANON_KEY) return { role: 'anon', uid: null };
    const uid = tokens.get(token);
    if (uid) return { role: 'user', uid };
    return { role: 'invalid', uid: null };
  }

  function uidFromRequest(req) {
    return tokenInfo(req).uid;
  }

  // PGlite 是单连接，请求必须串行，否则 set role / set_config 会互相串
  let queue = Promise.resolve();
  function serial(fn) {
    const run = queue.then(fn, fn);
    queue = run.then(() => {}, () => {});
    return run;
  }

  async function withRole(uid, fn) {
    await db.exec(`set role ${uid ? 'authenticated' : 'anon'}`);
    await db.query(`select set_config('test.uid', $1, false)`, [uid || '']);
    try {
      return await fn();
    } finally {
      await db.exec('reset role');
    }
  }

  const server = createServer((req, res) => {
    serial(async () => {
      try {
        await route(req, res);
      } catch (err) {
        if (!silent) console.error('[fake-supabase]', err);
        sendJson(res, err.status || 400, { message: err.message, code: err.code || 'P0001' });
      }
    });
  });

  async function route(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname;

    // ---------- Auth ----------
    if (path === '/auth/v1/signup' && req.method === 'POST') {
      const body = (await readBody(req)) || {};
      if (!body.email || !body.password) return sendJson(res, 400, { message: '缺少邮箱或密码' });
      if (usersByEmail.has(body.email)) {
        return sendJson(res, 422, { message: 'User already registered', code: 'user_already_exists' });
      }
      const id = randomUUID();
      await db.query(`insert into auth.users (id, email) values ($1, $2)`, [id, body.email]);
      usersByEmail.set(body.email, { id, password: body.password });
      return sendJson(res, 200, issueTokens(body.email));
    }

    if (path === '/auth/v1/token' && req.method === 'POST') {
      const body = (await readBody(req)) || {};
      const grant = url.searchParams.get('grant_type');
      if (grant === 'password') {
        const user = usersByEmail.get(body.email);
        if (!user || user.password !== body.password) {
          return sendJson(res, 400, { message: 'Invalid login credentials', code: 'invalid_grant' });
        }
        return sendJson(res, 200, issueTokens(body.email));
      }
      if (grant === 'refresh_token') {
        const uid = tokens.get(body.refresh_token);
        if (!uid) return sendJson(res, 400, { message: 'Invalid Refresh Token', code: 'refresh_token_not_found' });
        const email = [...usersByEmail.entries()].find(([, u]) => u.id === uid)?.[0];
        return sendJson(res, 200, issueTokens(email));
      }
      return sendJson(res, 400, { message: `不支持的 grant_type：${grant}` });
    }

    if (path === '/auth/v1/logout' && req.method === 'POST') {
      return sendEmpty(res, 204);
    }

    // ---------- RPC ----------
    const rpcMatch = path.match(/^\/rest\/v1\/rpc\/([a-z_][a-z0-9_]*)$/i);
    if (rpcMatch && req.method === 'POST') {
      const fn = rpcMatch[1];
      const body = (await readBody(req)) || {};
      const keys = Object.keys(body);
      const args = keys.map((k) => `${ident(k)} := ${lit(body[k])}`).join(', ');
      const info = tokenInfo(req);
      if (info.role === 'invalid') return sendJson(res, 401, { message: 'JWT expired', code: 'PGRST301' });
      const uid = info.uid;
      const result = await withRole(uid, () => db.query(`select * from public.${ident(fn)}(${args})`));
      // PostgREST：返回复合类型时，响应体是单个对象（不是数组）
      return sendJson(res, 200, result.rows[0] ?? null);
    }

    // ---------- 表 ----------
    const tableMatch = path.match(/^\/rest\/v1\/([a-z_][a-z0-9_]*)$/i);
    if (tableMatch) {
      const table = tableMatch[1];
      const params = [...url.searchParams.entries()];
      const select = url.searchParams.get('select');
      const order = url.searchParams.get('order');
      const limit = url.searchParams.get('limit');
      const prefer = String(req.headers.prefer || '');
      const wantsRows = /return=representation/i.test(prefer);
      const info = tokenInfo(req);
      if (info.role === 'invalid') return sendJson(res, 401, { message: 'JWT expired', code: 'PGRST301' });
      const uid = info.uid;

      if (req.method === 'GET') {
        // 模仿真 PostgREST：不带 limit 也只给 max-rows 条（Supabase 默认 1000），
        // 而且**静默截断**、HTTP 200。这不是我加戏，真服务就是这样——客户端必须自己翻页。
        const offset = Number(url.searchParams.get('offset') || 0);
        const asked = limit ? Number(limit) : MAX_ROWS;
        const effective = Math.min(Number.isFinite(asked) ? asked : MAX_ROWS, MAX_ROWS);
        const sql = `select ${buildColumns(select)} from public.${ident(table)}${buildWhere(params)}${buildOrder(order)} limit ${effective} offset ${offset}`;
        const result = await withRole(uid, () => db.query(sql));
        return sendJson(res, 200, result.rows);
      }

      if (req.method === 'POST') {
        const body = await readBody(req);
        const rows = Array.isArray(body) ? body : [body];
        if (!rows.length) return sendJson(res, 201, []);
        const columns = Object.keys(rows[0]);
        const values = rows
          .map((row) => `(${columns.map((c) => lit(row[c])).join(', ')})`)
          .join(', ');
        const sql = `insert into public.${ident(table)} (${columns.map(ident).join(', ')}) values ${values} returning *`;
        const result = await withRole(uid, () => db.query(sql));
        if (!wantsRows) return sendEmpty(res, 201);
        return sendJson(res, 201, result.rows);
      }

      if (req.method === 'PATCH') {
        const body = (await readBody(req)) || {};
        const sets = Object.entries(body)
          .map(([k, v]) => `${ident(k)} = ${lit(v)}`)
          .join(', ');
        const where = buildWhere(params);
        if (!where) return sendJson(res, 400, { message: 'PATCH 必须带过滤条件' });
        const sql = `update public.${ident(table)} set ${sets}${where} returning *`;
        const result = await withRole(uid, () => db.query(sql));
        if (!wantsRows) return sendEmpty(res, 204);
        return sendJson(res, 200, result.rows);
      }

      if (req.method === 'DELETE') {
        const where = buildWhere(params);
        if (!where) return sendJson(res, 400, { message: 'DELETE 必须带过滤条件' });
        await withRole(uid, () => db.query(`delete from public.${ident(table)}${where}`));
        return sendEmpty(res, 204);
      }
    }

    return sendJson(res, 404, { message: `没有这个接口：${req.method} ${path}` });
  }

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    anonKey: ANON_KEY,
    db,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await db.close();
    },
  };
}
