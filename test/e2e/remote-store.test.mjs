/**
 * 端到端测试：真实的 RemoteStore + SupabaseClient，跑在本地「假 Supabase」上
 * （假 Supabase 背后是真 Postgres/PGlite + 真 schema.sql + 真行级权限）。
 *
 * 和 test/remote.test.mjs 的区别：那个用假 fetch 验证「请求拼得对不对」，
 * 这个让请求真的被执行，验证「结果对不对」——包括 RLS 到底挡没挡住。
 *
 * 需要临时装 PGlite：
 *   npm i --no-save @electric-sql/pglite
 *   node test/e2e/remote-store.test.mjs
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeSupabase } from './fake-supabase.mjs';
import { RemoteStore } from '../../src/store.js';

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

let fake;
let store; // 爸爸
let family;

before(async () => {
  fake = await startFakeSupabase();
});

after(async () => {
  await fake?.close();
});

function makeStore() {
  return new RemoteStore({ url: fake.url, anonKey: fake.anonKey, storage: new MemStorage() });
}

test('注册 → 建家 → 自动写入默认分类和账户', async () => {
  store = makeStore();
  await store.signUp('dad@test.com', 'pw123456', '爸爸');
  assert.ok(store.client.userId, '注册后应该有登录态');

  family = await store.createFamily('我的家', '爸爸', 'father');
  assert.ok(family, 'createFamily 没返回家庭');
  assert.match(family.invite_code, /^[A-HJ-NP-Z2-9]{6}$/, `邀请码格式不对：${family.invite_code}`);
  assert.equal(store.family.id, family.id);

  const parents = store.categories.filter((c) => !c.parent_id);
  const children = store.categories.filter((c) => c.parent_id);
  assert.ok(parents.length >= 14, `默认大类太少：${parents.length}`);
  assert.ok(children.length >= 20, `默认小类太少：${children.length}`);
  assert.equal(store.accounts.length, 4, '默认账户应该有 4 个');
  assert.ok(children.every((c) => parents.some((p) => p.id === c.parent_id)), '存在挂不到大类的孤儿小类');
});

test('记一笔账，按月区间能查回来，区间外的查不到', async () => {
  const cat = store.categories.find((c) => c.kind === 'expense' && c.parent_id);
  const tx = await store.addTransaction({
    kind: 'expense',
    amount: 35.5,
    occurred_on: '2026-11-05',
    category_id: cat.id,
    member_id: store.profile.id,
    note: '买菜',
    raw_input: '今天买菜35.5元',
  });
  assert.ok(tx?.id, '没返回新账目');
  assert.equal(Number(tx.amount), 35.5);

  const inRange = await store.fetchTransactions('2026-11-01', '2026-11-30');
  assert.equal(inRange.length, 1, `区间内应查到 1 条，实际 ${inRange.length}`);
  assert.equal(inRange[0].note, '买菜');

  const outRange = await store.fetchTransactions('2026-12-01', '2026-12-31');
  assert.equal(outRange.length, 0, '区间过滤失效（gte/lte 没生效）');
});

test('改金额、删除账目都真的落到库里', async () => {
  const rows = await store.fetchTransactions('2026-11-01', '2026-11-30');
  const target = rows[0];

  const updated = await store.updateTransaction(target.id, { amount: 40, note: '买菜（改）' });
  assert.equal(Number(updated.amount), 40);
  assert.equal(updated.note, '买菜（改）');
  assert.ok(new Date(updated.updated_at) >= new Date(target.updated_at), 'updated_at 没更新');

  await store.deleteTransaction(target.id);
  const afterDelete = await store.fetchTransactions('2026-11-01', '2026-11-30');
  assert.equal(afterDelete.length, 0, '删了还在');
});

test('转账：两个账户都要记上，且不计入收支', async () => {
  const cash = store.accounts.find((a) => a.name === '现金');
  const bank = store.accounts.find((a) => a.name === '银行卡');
  const tx = await store.addTransaction({
    kind: 'transfer',
    amount: 500,
    occurred_on: '2026-11-06',
    account_id: bank.id,
    to_account_id: cash.id,
    note: '取现',
  });
  const rows = await store.fetchTransactions('2026-11-01', '2026-11-30');
  const back = rows.find((r) => r.id === tx.id);
  assert.equal(back.account_id, bank.id);
  assert.equal(back.to_account_id, cash.id);

  const { totals } = await import('../../src/analytics.js');
  const t = totals(rows);
  assert.equal(t.expense, 0, '转账被算进支出了');
  assert.equal(t.income, 0, '转账被算进收入了');
});

test('预算：写入、覆盖、清零', async () => {
  await store.saveBudget('2026-11', null, 5000);
  let rows = await store.listBudgets('2026-11');
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].amount), 5000);

  await store.saveBudget('2026-11', null, 6000); // 覆盖，不该变成两条
  rows = await store.listBudgets('2026-11');
  assert.equal(rows.length, 1, '覆盖预算时插了重复行');
  assert.equal(Number(rows[0].amount), 6000);

  const cat = store.categories.find((c) => c.kind === 'expense' && !c.parent_id);
  await store.saveBudget('2026-11', cat.id, 1200);
  rows = await store.listBudgets('2026-11');
  assert.equal(rows.length, 2, '分类预算没写进去');

  await store.saveBudget('2026-11', null, 0); // 清零 = 删除
  rows = await store.listBudgets('2026-11');
  assert.equal(rows.length, 1, '清零后总预算还在');
});

test('自定义分类：加得进、删得掉', async () => {
  const before = store.categories.length;
  const created = await store.addCategory({
    name: '宠物',
    kind: 'expense',
    keywords: ['狗粮', '猫砂'],
  });
  assert.ok(created?.id, '没返回新分类');
  assert.equal(store.categories.length, before + 1);
  assert.deepEqual(created.keywords, ['狗粮', '猫砂']);

  await store.deleteCategory(created.id);
  assert.equal(store.categories.length, before, '删了还留着');
});

test('家人用邀请码加入：看到同一本账', async () => {
  const mom = makeStore();
  await mom.signUp('mom@test.com', 'pw123456', '妈妈');
  const joined = await mom.joinFamily(family.invite_code.toLowerCase(), '妈妈', 'mother');
  assert.equal(joined.id, family.id, '加到了别的家庭');
  assert.equal(mom.family.id, family.id);

  const members = mom.members.map((m) => m.display_name).sort();
  assert.deepEqual(members, ['妈妈', '爸爸'].sort());

  const rows = await mom.fetchTransactions('2026-11-01', '2026-11-30');
  assert.ok(rows.length >= 1, '妈妈看不到爸爸记的账');
});

test('错误邀请码被拒', async () => {
  const stranger = makeStore();
  await stranger.signUp('x@test.com', 'pw123456', '路人');
  await assert.rejects(() => stranger.joinFamily('ZZZZZZ', '路人', 'other'), /邀请码不对/);
});

test('外人（未加入家庭）读不到任何账目', async () => {
  const outsider = makeStore();
  await outsider.signUp('c@test.com', 'pw123456', '外人');
  // 没建家也没入家：profile.family_id 为空
  const rows = await outsider.client.table('transactions', { select: '*' });
  assert.equal(rows.length, 0, `外人竟然读到了 ${rows.length} 条账目`);
});

test('另一个家庭互相看不见', async () => {
  const other = makeStore();
  await other.signUp('d@test.com', 'pw123456', '别人');
  const otherFamily = await other.createFamily('别人家', '别人', 'father');
  assert.notEqual(otherFamily.id, family.id);

  await other.addTransaction({ kind: 'expense', amount: 999, occurred_on: '2026-11-07', note: '别人家的账' });
  const otherRows = await other.fetchTransactions('2026-11-01', '2026-11-30');
  assert.equal(otherRows.length, 1);
  assert.equal(otherRows[0].note, '别人家的账');

  const mine = await store.fetchTransactions('2026-11-01', '2026-11-30');
  assert.ok(!mine.some((r) => r.note === '别人家的账'), '看到了别人家的账');
});

test('改不了自己的 family_id（越家被挡）', async () => {
  await assert.rejects(
    () =>
      store.client.table('members', {
        method: 'PATCH',
        filters: { id: `eq.${store.client.userId}` },
        body: { family_id: '99999999-9999-9999-9999-999999999999' },
        prefer: 'return=representation',
      }),
    /不能自己修改所属家庭|row-level security|拒绝|denied|violates/i,
  );
});

test('登录态持久化：换一个客户端仍能读写', async () => {
  const storage = new MemStorage();
  const a = new RemoteStore({ url: fake.url, anonKey: fake.anonKey, storage });
  await a.signIn('dad@test.com', 'pw123456');
  assert.equal(a.family.id, family.id);

  // 用同一份 storage 新建客户端，模拟刷新页面
  const b = new RemoteStore({ url: fake.url, anonKey: fake.anonKey, storage });
  await b.loadProfile();
  assert.equal(b.family.id, family.id, '刷新后丢了家庭');
  const rows = await b.fetchTransactions('2026-11-01', '2026-11-30');
  assert.ok(rows.length >= 1);
});

test('真实库数据 → 统计与图表：合计、分类、余额、预算、SVG 都正常', async () => {
  const A = await import('../../src/analytics.js');
  const C = await import('../../src/charts.js');

  // 清掉 11 月已有账目，让数字可控
  for (const row of await store.fetchTransactions('2026-11-01', '2026-11-30')) {
    await store.deleteTransaction(row.id);
  }

  const food = store.categories.find((c) => c.kind === 'expense' && !c.parent_id);
  const salary = store.categories.find((c) => c.kind === 'income' && !c.parent_id);
  const bank = store.accounts.find((a) => a.name === '银行卡');
  const cash = store.accounts.find((a) => a.name === '现金');

  await store.addTransaction({ kind: 'expense', amount: 35.5, occurred_on: '2026-11-03', category_id: food.id, account_id: cash.id, note: '午饭' });
  await store.addTransaction({ kind: 'expense', amount: 100, occurred_on: '2026-11-04', category_id: food.id, account_id: cash.id, note: '超市' });
  await store.addTransaction({ kind: 'income', amount: 5000, occurred_on: '2026-11-05', category_id: salary.id, account_id: bank.id, note: '工资' });
  await store.addTransaction({ kind: 'transfer', amount: 500, occurred_on: '2026-11-06', account_id: bank.id, to_account_id: cash.id, note: '取现' });

  const rows = await store.fetchTransactions('2026-11-01', '2026-11-30');
  assert.equal(rows.length, 4);

  const t = A.totals(rows);
  assert.equal(t.expense, 135.5, `支出合计不对：${t.expense}`);
  assert.equal(t.income, 5000, `收入合计不对：${t.income}`);

  const byCat = A.byCategory(rows, store.categories, 'expense');
  assert.equal(byCat[0].name, food.name);
  assert.equal(byCat[0].total, 135.5);

  const balances = A.accountBalances(rows, store.accounts);
  const cashBal = balances.find((b) => b.name === '现金');
  const bankBal = balances.find((b) => b.name === '银行卡');
  assert.equal(cashBal.balance, 364.5, `现金余额不对：${cashBal.balance}`);
  assert.equal(bankBal.balance, 4500, `银行卡余额不对：${bankBal.balance}`);

  const status = A.budgetStatus([{ category_id: null, amount: 100 }], rows, store.categories);
  assert.equal(status[0].state, 'over', '超支没被识别出来');

  const donut = C.donutChart(byCat);
  assert.match(donut, /<svg/, '饼图没生成 SVG');
  assert.ok(!/NaN/.test(donut), '饼图里出现了 NaN，说明数值没转成数字');
});
