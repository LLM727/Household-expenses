import test from 'node:test';
import assert from 'node:assert/strict';
import {
  totals, byCategory, byMember, byMonth, byDay, budgetStatus, compareWithPrev, expenseDelta,
  categoryTrend, accountBalances,
} from '../src/analytics.js';
import { DemoStore } from '../src/store.js';

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

const members = [
  { id: 'm-dad', display_name: '爸爸', role: 'father' },
  { id: 'm-mom', display_name: '妈妈', role: 'mother' },
  { id: 'm-kid', display_name: '小明', role: 'child' },
];

const categories = [
  { id: 'c-food', name: '餐饮', kind: 'expense', parent_id: null, icon: '🍚' },
  { id: 'c-food-out', name: '在外吃饭', kind: 'expense', parent_id: 'c-food', icon: null },
  { id: 'c-edu', name: '教育', kind: 'expense', parent_id: null, icon: '📚' },
  { id: 'c-salary', name: '工资薪金', kind: 'income', parent_id: null, icon: '💰' },
];

const tx = (over) => ({
  id: Math.random().toString(36).slice(2),
  kind: 'expense',
  amount: 100,
  occurred_on: '2026-11-05',
  category_id: 'c-food-out',
  member_id: 'm-dad',
  ...over,
});

test('totals：转账与借还一律不计入合计', () => {
  const list = [
    tx({ kind: 'expense', amount: 100 }),
    tx({ kind: 'income', amount: 5000, category_id: 'c-salary' }),
    tx({ kind: 'transfer', amount: 3000, category_id: null }),
    tx({ kind: 'lend', amount: 800, category_id: null }),
    tx({ kind: 'borrow', amount: 500, category_id: null }),
    tx({ kind: 'borrow_return', amount: 500, category_id: null }),
  ];
  const t = totals(list);
  assert.equal(t.expense, 100);
  assert.equal(t.income, 5000);
  assert.equal(t.net, 4900);
  assert.equal(t.special.transfer, 3000);
  assert.equal(t.special.lend, 800);
});

test('报销回款冲减支出，不算收入', () => {
  const list = [
    tx({ kind: 'expense', amount: 300 }),
    tx({ kind: 'reimburse_back', amount: 300 }),
  ];
  const t = totals(list);
  assert.equal(t.expense, 0);
  assert.equal(t.income, 0);
  assert.equal(expenseDelta({ kind: 'reimburse_back', amount: 50 }), -50);
});

test('byCategory：按金额降序，二级分类显示 父·子', () => {
  const list = [
    tx({ amount: 50, category_id: 'c-food-out' }),
    tx({ amount: 200, category_id: 'c-edu' }),
    tx({ amount: 30, category_id: 'c-food-out' }),
  ];
  const rows = byCategory(list, categories, 'expense');
  assert.equal(rows[0].categoryId, 'c-edu');
  assert.equal(rows[0].total, 200);
  assert.equal(rows[1].fullName, '餐饮·在外吃饭');
  assert.equal(rows[1].total, 80);
});

test('byMember：人员维度', () => {
  const list = [
    tx({ amount: 100, member_id: 'm-dad' }),
    tx({ amount: 60, member_id: 'm-mom' }),
    tx({ amount: 40, member_id: 'm-dad' }),
  ];
  const rows = byMember(list, members, 'expense');
  assert.equal(rows[0].name, '爸爸');
  assert.equal(rows[0].total, 140);
  assert.equal(rows[1].total, 60);
});

test('byMonth：跨月聚合与净额', () => {
  const list = [
    tx({ occurred_on: '2026-10-03', kind: 'expense', amount: 100 }),
    tx({ occurred_on: '2026-11-03', kind: 'income', amount: 1000, category_id: 'c-salary' }),
    tx({ occurred_on: '2026-11-04', kind: 'expense', amount: 200 }),
  ];
  const rows = byMonth(list, ['2026-10', '2026-11']);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].month, '2026-10');
  assert.equal(rows[0].expense, 100);
  assert.equal(rows[1].income, 1000);
  assert.equal(rows[1].expense, 200);
  assert.equal(rows[1].net, 800);
});

test('byDay：补齐当月天数', () => {
  const rows = byDay([tx({ occurred_on: '2026-11-08', amount: 88 })], '2026-11');
  assert.equal(rows.length, 30);
  assert.equal(rows[7].expense, 88);
});

test('budgetStatus：正常/即将超支/已超支', () => {
  const budgets = [
    { id: 'b1', category_id: 'c-edu', amount: 1000 },
    { id: 'b2', category_id: 'c-food', amount: 100 },
    { id: 'b3', category_id: 'c-food-out', amount: 50 },
    { id: 'b4', category_id: null, amount: 10000 },
  ];
  const list = [
    tx({ amount: 900, category_id: 'c-edu' }),
    tx({ amount: 90, category_id: 'c-food' }),
    tx({ amount: 90, category_id: 'c-food-out' }),
  ];
  const rows = budgetStatus(budgets, list, categories, 0.8);
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
  // 教育没有小类：900 / 1000
  assert.equal(byName['教育'].used, 900);
  assert.equal(byName['教育'].state, 'warn');
  // 餐饮是把「在外吃饭」那 90 也算进来的：90 + 90 = 180，超了 100 的预算
  assert.equal(byName['餐饮'].used, 180, '大类预算没把小类的钱汇总进来');
  assert.equal(byName['餐饮'].state, 'over');
  assert.equal(byName['餐饮'].remaining, -80);
  // 小类预算只管自己这 90
  assert.equal(byName['餐饮·在外吃饭'].used, 90);
  assert.equal(byName['餐饮·在外吃饭'].state, 'over');
  // 总预算 = 900 + 90 + 90
  assert.equal(byName['总预算'].used, 1080);
  assert.equal(byName['总预算'].state, 'ok');
});

test('budgetStatus：大类预算要汇总小类，小类预算不反向吃大类的账', () => {
  // 这是给「界面上只能给大类设预算」配的规则。用户给「餐饮」设 1000，
  // 钱几乎都记在小类（餐饮/买菜、餐饮/在外吃饭）上。如果只按 category_id 精确相等，
  // 大类的预算永远显示「已用 0」、永远不超支——设了跟没设一样。
  const cats = [
    { id: 'food', name: '餐饮', kind: 'expense', parent_id: null, fullName: '餐饮' },
    { id: 'food-market', name: '买菜', kind: 'expense', parent_id: 'food', fullName: '餐饮/买菜' },
    { id: 'food-out', name: '在外吃饭', kind: 'expense', parent_id: 'food', fullName: '餐饮/在外吃饭' },
    { id: 'traffic', name: '交通', kind: 'expense', parent_id: null, fullName: '交通' },
  ];
  const budgets = [
    { id: 'b-food', category_id: 'food', amount: 1000 },
    { id: 'b-market', category_id: 'food-market', amount: 500 },
  ];
  const list = [
    tx({ amount: 800, category_id: 'food-market' }),
    tx({ amount: 200, category_id: 'food-out' }),
    tx({ amount: 100, category_id: 'food' }), // 直接记在大类上，也要算
    tx({ amount: 50, category_id: 'traffic' }), // 别的分类不能串进来
  ];
  const rows = budgetStatus(budgets, list, cats, 0.8);
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));

  // 餐饮 = 买菜 800 + 在外吃饭 200 + 直接记的 100；交通那 50 不算
  assert.equal(byName['餐饮'].used, 1100, '大类预算的汇总口径不对');
  assert.equal(byName['餐饮'].state, 'over');

  // 小类预算只算自己，不把兄弟分类的钱也加进来
  assert.equal(byName['餐饮·买菜'].used, 800, '小类预算算了别的分类的钱');
  assert.equal(byName['餐饮·买菜'].state, 'over');
});

test('compareWithPrev：环比百分比', () => {  const cur = [tx({ amount: 150 })];
  const prev = [tx({ amount: 100 })];
  const r = compareWithPrev(cur, prev);
  assert.equal(r.expense.current, 150);
  assert.equal(r.expense.previous, 100);
  assert.equal(r.expense.pct, 50);
});

test('DemoStore：种子数据可用、可增删改', async () => {
  const store = new DemoStore(new MemStorage());
  assert.equal(store.mode, 'demo');
  assert.ok(store.members.length === 3);
  assert.ok(store.categories.length > 20);
  assert.ok(store.transactions === undefined); // 不在公开接口上暴露

  const from = '2020-01-01';
  const to = '2099-12-31';
  const before = await store.fetchTransactions(from, to);
  assert.ok(before.length >= 40, `演示数据条数：${before.length}`);

  const created = await store.addTransaction({
    kind: 'expense',
    amount: 12.5,
    occurred_on: '2026-11-11',
    category_id: store.categories[0].id,
    member_id: 'm-kid',
    note: '测试',
  });
  const after = await store.fetchTransactions(from, to);
  assert.equal(after.length, before.length + 1);
  assert.equal(after.find((t) => t.id === created.id).note, '测试');

  await store.updateTransaction(created.id, { amount: 20 });
  const updated = (await store.fetchTransactions(from, to)).find((t) => t.id === created.id);
  assert.equal(Number(updated.amount), 20);

  await store.deleteTransaction(created.id);
  assert.equal((await store.fetchTransactions(from, to)).length, before.length);
});

test('DemoStore：预算保存与覆盖', async () => {
  const store = new DemoStore(new MemStorage());
  await store.saveBudget('2026-11', null, 5000);
  await store.saveBudget('2026-11', 'c-food', 800);
  let rows = await store.listBudgets('2026-11');
  assert.equal(rows.length, 2);
  await store.saveBudget('2026-11', 'c-food', 900);
  rows = await store.listBudgets('2026-11');
  assert.equal(rows.length, 2);
  assert.equal(rows.find((b) => b.category_id === 'c-food').amount, 900);
  await store.saveBudget('2026-11', 'c-food', 0);
  rows = await store.listBudgets('2026-11');
  assert.equal(rows.length, 1);
});

test('categoryTrend：分类 × 月份矩阵，按总额降序取前 N', () => {
  const list = [
    tx({ occurred_on: '2026-09-05', amount: 100, category_id: 'c-food' }),
    tx({ occurred_on: '2026-10-05', amount: 200, category_id: 'c-food' }),
    tx({ occurred_on: '2026-11-05', amount: 300, category_id: 'c-food' }),
    tx({ occurred_on: '2026-11-06', amount: 50, category_id: 'c-edu' }),
    tx({ occurred_on: '2026-11-07', amount: 999, category_id: 'c-salary', kind: 'income' }),
    tx({ occurred_on: '2026-11-08', amount: 777, category_id: null, kind: 'transfer' }),
  ];
  const r = categoryTrend(list, categories, ['2026-09', '2026-10', '2026-11'], 5);
  assert.deepEqual(r.months, ['2026-09', '2026-10', '2026-11']);
  assert.equal(r.rows.length, 2, '收入和转账不该出现在支出趋势里');
  assert.equal(r.rows[0].name, '餐饮');
  assert.deepEqual(r.rows[0].values, [100, 200, 300]);
  assert.equal(r.rows[0].total, 600);
  assert.equal(r.rows[1].name, '教育');
  assert.deepEqual(r.rows[1].values, [0, 0, 50]);
});

test('categoryTrend：topN 截断', () => {
  const list = [
    tx({ occurred_on: '2026-11-01', amount: 100, category_id: 'c-food' }),
    tx({ occurred_on: '2026-11-02', amount: 200, category_id: 'c-edu' }),
    tx({ occurred_on: '2026-11-03', amount: 300, category_id: null }),
  ];
  const r = categoryTrend(list, categories, ['2026-11'], 2);
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0].name, '未分类');
  assert.equal(r.rows[0].categoryId, null);
  assert.equal(r.rows[1].name, '教育');
});
