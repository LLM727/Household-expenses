/**
 * 数据库结构自测：用真 Postgres（PGlite，WASM 版）把 schema.sql 跑一遍，
 * 验证建表、邀请码建家、行级权限、触发器是不是真的按预期工作。
 *
 * 这不是应用的一部分，平时不用跑。改动 supabase/schema.sql 之后建议跑一次：
 *
 *   npm i --no-save @electric-sql/pglite      # 临时装，不进 package.json
 *   node supabase/validate-schema.mjs
 *
 * 它会伪造 Supabase 的 auth.users / auth.uid() / anon 角色，然后逐项断言。
 */

import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const SCHEMA_PATH = new URL('./schema.sql', import.meta.url);
const SCHEMA = readFileSync(SCHEMA_PATH, 'utf8');

const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ ok: true, name });
    console.log(`PASS  ${name}${detail ? ' — ' + detail : ''}`);
  } catch (err) {
    results.push({ ok: false, name, detail: err.message });
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const db = await PGlite.create();

/* ---- 伪造 Supabase 环境（真实项目里这些是自带的） ---- */
await db.exec(`
  create schema if not exists auth;
  create table if not exists auth.users (
    id uuid primary key default gen_random_uuid(),
    email text
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

/* ---- 1. 执行 schema.sql ---- */
let schemaError = null;
try {
  await db.exec(SCHEMA);
} catch (err) {
  if (/pgcrypto/i.test(err.message)) {
    console.log('提示：PGlite 不含 pgcrypto 扩展，跳过该行重试（Supabase 自带，不影响）');
    await db.exec(SCHEMA.replace(/create extension[^;]*pgcrypto[^;]*;/i, ''));
  } else {
    schemaError = err;
  }
}

await check('schema.sql 整体执行无语法错误', async () => {
  if (schemaError) throw schemaError;
  const t = await db.query(`select count(*)::int n from pg_tables where schemaname='public'`);
  assert(t.rows[0].n === 6, `表数量是 ${t.rows[0].n}，应为 6`);
  return '6 张表';
});

await check('6 张表都开了行级权限', async () => {
  const r = await db.query(
    `select count(*)::int n from pg_tables where schemaname='public' and rowsecurity = true`,
  );
  assert(r.rows[0].n === 6, `只有 ${r.rows[0].n} 张表开启了 RLS`);
  return 'rowsecurity = true ×6';
});

await check('触发器都在', async () => {
  const r = await db.query(`select tgname from pg_trigger where not tgisinternal order by tgname`);
  const names = r.rows.map((x) => x.tgname);
  assert(names.includes('transactions_touch'), '缺 transactions_touch');
  assert(names.includes('members_guard_family'), '缺 members_guard_family');
  return names.join(', ');
});

/* ---- 2. 补上 Supabase 默认会有的表权限 ---- */
await db.exec(`
  grant usage on schema public to anon, authenticated;
  grant all on all tables in schema public to anon, authenticated;
  grant all on all sequences in schema public to anon, authenticated;
  grant usage on schema auth to anon, authenticated;
  grant select on auth.users to anon, authenticated;
`);

/* ---- 3. 建家 ---- */
const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';
const USER_C = '33333333-3333-3333-3333-333333333333';

await db.exec(`insert into auth.users (id, email) values
  ('${USER_A}','a@x.com'), ('${USER_B}','b@x.com'), ('${USER_C}','c@x.com')`);
await db.exec(`select set_config('test.uid','${USER_A}', false)`);

let familyA;
await check('create_family 能建家并返回邀请码', async () => {
  // 注意：不要写成 select (public.create_family(...)).*，
  // Postgres 会把 volatile 函数算两次，第二次就会报「你已经在某个家庭里了」
  const r = await db.query(`select * from public.create_family('测试家庭','爸爸','father')`);
  familyA = r.rows[0];
  assert(familyA?.id, '没返回家庭');
  assert(/^[A-HJ-NP-Z2-9]{6}$/.test(familyA.invite_code), `邀请码格式不对：${familyA.invite_code}`);
  return `邀请码 ${familyA.invite_code}`;
});

await check('建家后自己成了成员', async () => {
  const r = await db.query(`select display_name, role, family_id from public.members where id = '${USER_A}'`);
  assert(r.rows.length === 1, '没有成员行');
  assert(r.rows[0].display_name === '爸爸', '称呼没写进去');
  assert(r.rows[0].family_id === familyA.id, 'family_id 不对');
  return `${r.rows[0].display_name}/${r.rows[0].role}`;
});

await check('同一个人不能建第二个家', async () => {
  try {
    await db.query(`select public.create_family('第二个家','爸爸','father')`);
  } catch (err) {
    assert(/已经在某个家庭/.test(err.message), `报错不对：${err.message}`);
    return err.message;
  }
  throw new Error('居然建成功了');
});

/* ---- 4. 邀请码入家 ---- */
await db.exec(`select set_config('test.uid','${USER_B}', false)`);
await check('join_family_by_code 用邀请码加入', async () => {
  const r = await db.query(`select * from public.join_family_by_code('${familyA.invite_code}','妈妈','mother')`);
  assert(r.rows[0].id === familyA.id, '加到了别的家庭');
  const m = await db.query(`select display_name from public.members where id='${USER_B}'`);
  assert(m.rows[0].display_name === '妈妈', '称呼没写进去');
  return '妈妈 已加入';
});

await check('邀请码错时给明确报错', async () => {
  await db.exec(`select set_config('test.uid','${USER_C}', false)`);
  try {
    await db.query(`select public.join_family_by_code('ZZZZZZ','小明','child')`);
  } catch (err) {
    assert(/邀请码不对/.test(err.message), `报错不对：${err.message}`);
    return err.message;
  }
  throw new Error('错的邀请码居然能加入');
});

await check('未登录调函数被拒', async () => {
  await db.exec(`select set_config('test.uid','', false)`);
  try {
    await db.query(`select public.create_family('x','x','father')`);
  } catch (err) {
    assert(/未登录/.test(err.message), `报错不对：${err.message}`);
    return err.message;
  }
  throw new Error('未登录居然能建家');
});

/* ---- 5. 行级权限 ---- */
await check('成员改不了自己的 family_id', async () => {
  await db.exec(`select set_config('test.uid','${USER_A}', false)`);
  await db.exec(`insert into public.families (id, name, invite_code) values
    ('99999999-9999-9999-9999-999999999999','别人家','OTHER1')`);
  try {
    await db.query(`update public.members set family_id = '99999999-9999-9999-9999-999999999999' where id='${USER_A}'`);
  } catch (err) {
    assert(/不能自己修改所属家庭/.test(err.message), `报错不对：${err.message}`);
    return err.message;
  }
  throw new Error('居然改成功了——越家漏洞还在');
});

await check('跨家庭读不到别人的账', async () => {
  await db.exec(`set role authenticated`);
  await db.exec(`select set_config('test.uid','${USER_A}', false)`);
  await db.exec(`
    insert into public.transactions (family_id, kind, amount, occurred_on, note)
    values ('${familyA.id}','expense',35.50,'2026-11-11','A家的买菜钱')
  `);
  const own = await db.query(`select note from public.transactions`);
  assert(own.rows.length === 1, `自己家应该看到 1 条，看到 ${own.rows.length}`);

  await db.exec(`select set_config('test.uid','${USER_C}', false)`);
  const other = await db.query(`select note from public.transactions`);
  assert(other.rows.length === 0, `C 不是这家人，却看到了 ${other.rows.length} 条`);
  await db.exec(`reset role`);
  return '自己 1 条 / 外人 0 条';
});

await check('伪造 family_id 写入被挡', async () => {
  await db.exec(`set role authenticated`);
  await db.exec(`select set_config('test.uid','${USER_C}', false)`);
  try {
    await db.query(`
      insert into public.transactions (family_id, kind, amount, occurred_on)
      values ('${familyA.id}','expense',1,'2026-11-11')
    `);
  } catch (err) {
    await db.exec(`reset role`);
    assert(/row-level security|violates|denied/i.test(err.message), `报错不对：${err.message}`);
    return err.message.slice(0, 60);
  }
  await db.exec(`reset role`);
  throw new Error('外人居然能往别人家里插账');
});

await check('匿名（anon）读不到任何家庭', async () => {
  await db.exec(`set role anon`);
  await db.exec(`select set_config('test.uid','', false)`);
  const r = await db.query(`select * from public.families`);
  await db.exec(`reset role`);
  assert(r.rows.length === 0, `匿名读到了 ${r.rows.length} 个家庭`);
  return '0 行';
});

await check('预算唯一索引生效（同月同类只能一条）', async () => {
  await db.exec(`set role authenticated`);
  await db.exec(`select set_config('test.uid','${USER_A}', false)`);
  await db.exec(`
    insert into public.budgets (family_id, month, category_id, amount)
    values ('${familyA.id}','2026-11',null,5000)
  `);
  let failed = false;
  try {
    await db.exec(`
      insert into public.budgets (family_id, month, category_id, amount)
      values ('${familyA.id}','2026-11',null,6000)
    `);
  } catch (err) {
    failed = /duplicate|unique/i.test(err.message);
  }
  await db.exec(`reset role`);
  assert(failed, '同月总预算插了两条，唯一索引没起作用');
  return '重复插入被拒';
});

await check('updated_at 触发器会改时间', async () => {
  await db.exec(`set role authenticated`);
  await db.exec(`select set_config('test.uid','${USER_A}', false)`);
  const before = await db.query(`select updated_at from public.transactions limit 1`);
  await db.exec(`update public.transactions set amount = 40 where note = 'A家的买菜钱'`);
  const after = await db.query(`select updated_at from public.transactions limit 1`);
  await db.exec(`reset role`);
  assert(new Date(after.rows[0].updated_at) > new Date(before.rows[0].updated_at), 'updated_at 没变');
  return 'ok';
});

const failed = results.filter((r) => !r.ok);
console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`);
if (failed.length) {
  console.log('失败项：\n' + failed.map((f) => ` - ${f.name}: ${f.detail}`).join('\n'));
  process.exit(1);
}
