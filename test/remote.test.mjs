/**
 * 远程层测试：用假的 fetch 验证 Supabase 客户端的请求构造（地址、方法、请求头、请求体），
 * 以及 RemoteStore 的「建家 → 写入默认分类和账户」流程。
 * 全部离线，不需要真的 Supabase 项目。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SupabaseClient, SupabaseError } from '../src/supabase.js';
import { RemoteStore } from '../src/store.js';

/**
 * 从 schema.sql 里抽出每张表的列名。
 * 用途：校验所有发往 PostgREST 的写入体里，字段名都是表上真实存在的列。
 * 这一条是补上来的——曾经往 accounts 写了不存在的 sort 列，
 * PostgREST 会整批拒绝，等于「第一次建家必然失败」，而假的 fetch 什么都收，查不出来。
 */
function tableColumnsFromSchema() {
  const sql = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
  const NOT_A_COLUMN = new Set(['primary', 'unique', 'constraint', 'check', 'foreign', 'exclude']);
  const tables = new Map();
  for (const m of sql.matchAll(/create table if not exists public\.(\w+)\s*\(([\s\S]*?)\n\);/g)) {
    const columns = new Set();
    for (const line of m[2].split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('--')) continue;
      const name = trimmed.split(/[\s,]+/)[0].toLowerCase();
      if (!/^[a-z_][a-z0-9_]*$/.test(name) || NOT_A_COLUMN.has(name)) continue;
      columns.add(name);
    }
    tables.set(m[1].toLowerCase(), columns);
  }
  return tables;
}

const SCHEMA_COLUMNS = tableColumnsFromSchema();

class MemStorage {
  constructor() {
    this.map = new Map();
  }

  getItem(k) {
    return this.map.has(k) ? this.map.get(k) : null;
  }

  setItem(k, v) {
    this.map.set(k, String(v));
  }

  removeItem(k) {
    this.map.delete(k);
  }
}

const URL_BASE = 'https://demo.supabase.co';
const KEY = 'test-anon-key';

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  };
}

function makeFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const parsed = new URL(url);
    const record = {
      url,
      path: parsed.pathname,
      query: Object.fromEntries(parsed.searchParams.entries()),
      method: init.method || 'GET',
      headers: init.headers || {},
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(record);

    // 写入体的字段名必须是表上真实存在的列
    const tableMatch = record.path.match(/^\/rest\/v1\/([a-z_][a-z0-9_]*)$/i);
    if (tableMatch && SCHEMA_COLUMNS.has(tableMatch[1].toLowerCase())
        && (record.method === 'POST' || record.method === 'PATCH')) {
      const columns = SCHEMA_COLUMNS.get(tableMatch[1].toLowerCase());
      const rows = Array.isArray(record.body) ? record.body : [record.body];
      record.unknownColumns = rows
        .flatMap((row) => Object.keys(row || {}))
        .filter((key) => !columns.has(key.toLowerCase()));
    }

    const result = handler(record, calls);
    if (result instanceof Error) throw result;
    return result ?? jsonResponse(200, null);
  };
  fn.calls = calls;
  return fn;
}

function newClient(fetchImpl, storage = new MemStorage()) {
  globalThis.fetch = fetchImpl;
  return new SupabaseClient({ url: URL_BASE, anonKey: KEY, storage });
}

const authPayload = {
  access_token: 'access-abc',
  refresh_token: 'refresh-abc',
  expires_in: 3600,
  user: { id: 'user-1', email: 'a@b.com' },
};

test('登录：地址、方法、请求体、apikey 正确', async () => {
  const f = makeFetch((rec) => {
    if (rec.path === '/auth/v1/token') return jsonResponse(200, authPayload);
    return null;
  });
  const client = newClient(f);
  await client.signIn('a@b.com', 'secret1');

  const call = f.calls[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.path, '/auth/v1/token');
  assert.equal(call.query.grant_type, 'password');
  assert.equal(call.headers.apikey, KEY);
  assert.deepEqual(call.body, { email: 'a@b.com', password: 'secret1' });
  assert.equal(client.userId, 'user-1');
  assert.ok(client.session.expires_at > Date.now());
});

test('注册但项目开启邮箱确认：给出可读提示', async () => {
  const f = makeFetch(() => jsonResponse(200, { id: 'user-1', email: 'a@b.com' }));
  const client = newClient(f);
  await assert.rejects(() => client.signUp('a@b.com', 'secret1', '爸爸'), (err) => {
    assert.ok(err instanceof SupabaseError);
    assert.equal(err.code, 'email_confirmation_required');
    return true;
  });
});

test('查询构造：select / 区间过滤 / 排序 / 分页都进 URL', async () => {
  const f = makeFetch(() => jsonResponse(200, []));
  const client = newClient(f);
  client._writeSession({ access_token: 't', refresh_token: 'r', expires_at: Date.now() + 1e6, user: authPayload.user });

  await client.table('transactions', {
    select: '*',
    filters: { occurred_on: 'gte.2026-11-01', and: '(occurred_on.lte.2026-11-30)' },
    order: 'occurred_on.desc,created_at.desc',
    limit: 50,
  });

  const call = f.calls[0];
  assert.equal(call.method, 'GET');
  assert.equal(call.path, '/rest/v1/transactions');
  assert.equal(call.query.select, '*');
  assert.equal(call.query.occurred_on, 'gte.2026-11-01');
  assert.equal(call.query.and, '(occurred_on.lte.2026-11-30)');
  assert.equal(call.query.order, 'occurred_on.desc,created_at.desc');
  assert.equal(call.query.limit, '50');
  assert.equal(call.headers.Authorization, 'Bearer t');
});

test('写入：POST 默认带 return=representation', async () => {
  const f = makeFetch(() => jsonResponse(201, [{ id: 'tx-1' }]));
  const client = newClient(f);
  client._writeSession({ access_token: 't', refresh_token: 'r', expires_at: Date.now() + 1e6, user: authPayload.user });

  const rows = await client.table('transactions', { method: 'POST', body: { amount: 12 } });
  assert.deepEqual(rows, [{ id: 'tx-1' }]);
  assert.equal(f.calls[0].method, 'POST');
  assert.equal(f.calls[0].headers.Prefer, 'return=representation');
  assert.deepEqual(f.calls[0].body, { amount: 12 });
});

test('令牌过期会自动刷新后再发请求', async () => {
  const f = makeFetch((rec) => {
    if (rec.path === '/auth/v1/token') return jsonResponse(200, { ...authPayload, access_token: 'new-token' });
    return jsonResponse(200, []);
  });
  const client = newClient(f);
  client._writeSession({
    access_token: 'old-token',
    refresh_token: 'refresh-abc',
    expires_at: Date.now() - 1000,
    user: authPayload.user,
  });

  await client.table('families', { select: '*' });

  assert.equal(f.calls[0].query.grant_type, 'refresh_token');
  const dataCall = f.calls[1];
  assert.equal(dataCall.path, '/rest/v1/families');
  assert.equal(dataCall.headers.Authorization, 'Bearer new-token');
});

test('服务端错误会变成带 message 的 SupabaseError', async () => {
  const f = makeFetch(() => jsonResponse(400, { message: 'Invalid login credentials', code: 'invalid_grant' }));
  const client = newClient(f);
  await assert.rejects(() => client.signIn('a@b.com', 'nope'), (err) => {
    assert.ok(err instanceof SupabaseError);
    assert.equal(err.message, 'Invalid login credentials');
    assert.equal(err.status, 400);
    return true;
  });
});

test('RemoteStore：建家后自动写入默认分类与账户', async () => {
  const state = {
    familyId: 'fam-1',
    postedCategories: [],
    postedAccounts: [],
  };

  const f = makeFetch((rec) => {
    // 建家
    if (rec.path === '/rest/v1/rpc/create_family') {
      return jsonResponse(200, [{ id: state.familyId, name: '我的家', invite_code: 'K3M9QP' }]);
    }
    // 写入分类：父级返回带 id 的行，子级只回空
    if (rec.path === '/rest/v1/categories' && rec.method === 'POST') {
      const rows = rec.body;
      state.postedCategories.push(...rows);
      return jsonResponse(201, rows.map((r, i) => ({ ...r, id: `${r.parent_id ? 'child' : 'parent'}-${i}` })));
    }
    if (rec.path === '/rest/v1/accounts' && rec.method === 'POST') {
      state.postedAccounts.push(...rec.body);
      return jsonResponse(201, []);
    }
    // 读家庭成员档案
    if (rec.path === '/rest/v1/members' && rec.method === 'GET') {
      return jsonResponse(200, [{ id: 'user-1', family_id: state.familyId, display_name: '爸爸', role: 'father' }]);
    }
    if (rec.path === '/rest/v1/families') {
      return jsonResponse(200, [{ id: state.familyId, name: '我的家', invite_code: 'K3M9QP' }]);
    }
    if (rec.path === '/rest/v1/categories' && rec.method === 'GET') {
      return jsonResponse(200, []);
    }
    if (rec.path === '/rest/v1/accounts' && rec.method === 'GET') {
      return jsonResponse(200, []);
    }
    return jsonResponse(200, []);
  });

  const storage = new MemStorage();
  globalThis.fetch = f;
  const store = new RemoteStore({ url: URL_BASE, anonKey: KEY, storage });
  store.client._writeSession({
    access_token: 't', refresh_token: 'r', expires_at: Date.now() + 1e6, user: authPayload.user,
  });

  await store.createFamily('我的家', '爸爸', 'father');

  assert.equal(store.family.id, 'fam-1');
  assert.equal(store.family.invite_code, 'K3M9QP');

  const parents = state.postedCategories.filter((c) => c.parent_id === null);
  const children = state.postedCategories.filter((c) => c.parent_id);
  assert.ok(parents.length >= 14, `默认大类太少：${parents.length}`);
  assert.ok(children.length >= 20, `默认小类太少：${children.length}`);
  assert.equal(state.postedAccounts.length, 4);
  assert.ok(state.postedAccounts.every((a) => a.family_id === 'fam-1'));
  // 两级分类的父 id 必须来自真实插入结果
  assert.ok(children.every((c) => String(c.parent_id).startsWith('parent-')));
});

test('RemoteStore：加入家庭用邀请码，走 RPC 而不是直接写表', async () => {
  const f = makeFetch((rec) => {
    if (rec.path === '/rest/v1/rpc/join_family_by_code') {
      return jsonResponse(200, [{ id: 'fam-9', name: '岳父母家', invite_code: 'QQQ222' }]);
    }
    if (rec.path === '/rest/v1/members') {
      return jsonResponse(200, [{ id: 'user-2', family_id: 'fam-9', display_name: '妈妈', role: 'mother' }]);
    }
    if (rec.path === '/rest/v1/families') {
      return jsonResponse(200, [{ id: 'fam-9', name: '岳父母家', invite_code: 'QQQ222' }]);
    }
    return jsonResponse(200, []);
  });
  globalThis.fetch = f;
  const store = new RemoteStore({ url: URL_BASE, anonKey: KEY, storage: new MemStorage() });
  store.client._writeSession({
    access_token: 't', refresh_token: 'r', expires_at: Date.now() + 1e6, user: { id: 'user-2' },
  });

  const family = await store.joinFamily('qqq222', '妈妈', 'mother');
  const rpcCall = f.calls.find((c) => c.path === '/rest/v1/rpc/join_family_by_code');
  assert.ok(rpcCall, '没有调用 join_family_by_code');
  assert.deepEqual(rpcCall.body, { p_code: 'qqq222', p_display_name: '妈妈', p_role: 'mother' });
  assert.equal(family.id, 'fam-9');
});

test('写库字段名都出自 schema.sql（列名写错会被这里抓到）', async () => {
  let seq = 0;
  const f = makeFetch((rec) => {
    if (rec.path === '/auth/v1/signup') return jsonResponse(200, authPayload);
    if (rec.path === '/rest/v1/rpc/create_family') {
      // PostgREST 对复合返回类型给的是对象，不是数组（真实行为）
      return jsonResponse(200, { id: 'fam-1', name: '我的家', invite_code: 'K3M9QP' });
    }
    if (rec.path === '/rest/v1/categories' && rec.method === 'POST') {
      const rows = Array.isArray(rec.body) ? rec.body : [rec.body];
      return jsonResponse(201, rows.map((row) => ({ ...row, id: `cat-${seq++}` })));
    }
    if (rec.path === '/rest/v1/accounts' && rec.method === 'POST') return jsonResponse(201, []);
    if (rec.path === '/rest/v1/members' && rec.method === 'GET') {
      return jsonResponse(200, [{ id: 'user-1', family_id: 'fam-1', display_name: '爸爸', role: 'father' }]);
    }
    if (rec.path === '/rest/v1/families' && rec.method === 'GET') {
      return jsonResponse(200, [{ id: 'fam-1', name: '我的家', invite_code: 'K3M9QP' }]);
    }
    if (rec.path === '/rest/v1/transactions') {
      return jsonResponse(201, [{ id: 'tx-1', ...(rec.body || {}) }]);
    }
    if (rec.path === '/rest/v1/budgets') {
      return rec.method === 'DELETE' ? jsonResponse(204) : jsonResponse(201, [{ id: 'bud-1', ...rec.body }]);
    }
    return jsonResponse(200, []);
  });
  globalThis.fetch = f;

  const store = new RemoteStore({ url: URL_BASE, anonKey: KEY, storage: new MemStorage() });
  await store.signUp('a@b.com', 'pw123456', '爸爸');
  await store.createFamily('我的家', '爸爸', 'father');
  await store.addTransaction({ kind: 'expense', amount: 10, occurred_on: '2026-11-01', note: '测试' });
  await store.saveBudget('2026-11', null, 3000);
  await store.addCategory({ name: '宠物', kind: 'expense', keywords: ['狗粮'] });
  await store.updateProfile({ display_name: '老爸', role: 'father' });
  await store.updateFamily({ name: '新家名' });

  const offenders = f.calls
    .filter((c) => c.unknownColumns && c.unknownColumns.length)
    .map((c) => `${c.method} ${c.path} → 不存在的列：${c.unknownColumns.join(', ')}`);
  assert.deepEqual(offenders, [], `这些字段在 schema.sql 里没有，真实 Supabase 会整批拒绝：\n${offenders.join('\n')}`);

  assert.ok(
    f.calls.some((c) => c.path === '/rest/v1/accounts' && c.method === 'POST'),
    '没跑到默认账户写入，这个测试白跑了',
  );
});

function publicMethods(block) {
  return new Set(
    [...block.matchAll(/^  (?:async )?([a-z]\w*)\(/gm)]
      .map((m) => m[1])
      .filter((name) => name !== 'constructor'),
  );
}

test('界面调用的每个 store 方法，两种实现都有', () => {
  const storeSrc = readFileSync(new URL('../src/store.js', import.meta.url), 'utf8');
  const appSrc = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');

  const remoteAt = storeSrc.indexOf('export class RemoteStore');
  const demoAt = storeSrc.indexOf('class DemoStore');
  assert.ok(remoteAt > 0 && demoAt > remoteAt, '没找到两个类的定义');
  const remote = publicMethods(storeSrc.slice(remoteAt, demoAt));
  const demo = publicMethods(storeSrc.slice(demoAt));

  const used = new Set([...appSrc.matchAll(/this\.store\.([a-zA-Z_]\w*)\s*\(/g)].map((m) => m[1]));
  assert.ok(used.size >= 10, `只识别到 ${used.size} 个调用，正则可能失效了`);

  const missingRemote = [...used].filter((m) => !remote.has(m));
  const missingDemo = [...used].filter((m) => !demo.has(m));
  assert.deepEqual(missingRemote, [], `RemoteStore 缺这些方法（配好 Supabase 后一点就报错）：${missingRemote.join(', ')}`);
  assert.deepEqual(missingDemo, [], `DemoStore 缺这些方法（演示模式一点就报错）：${missingDemo.join(', ')}`);
});
