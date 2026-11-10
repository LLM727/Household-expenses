/** 账户识别与余额推算 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEntry, matchAccounts } from '../src/parse.js';
import { accountBalances } from '../src/analytics.js';
import { DEFAULT_CATEGORIES } from '../src/defaults.js';

function flatCats() {
  const rows = [];
  for (const p of DEFAULT_CATEGORIES) {
    rows.push({ id: p.key, name: p.name, kind: p.kind, parent_id: null, fullName: p.name, keywords: p.keywords || [] });
    for (const c of p.children || []) {
      rows.push({
        id: c.key, name: c.name, kind: p.kind, parent_id: p.key,
        fullName: `${p.name}/${c.name}`, keywords: c.keywords || [],
      });
    }
  }
  return rows;
}

const accounts = [
  { id: 'acc-cash', name: '现金' },
  { id: 'acc-bank', name: '银行卡' },
  { id: 'acc-wx', name: '微信' },
];

const ctx = {
  today: '2026-11-11',
  members: [{ id: 'm-dad', display_name: '爸爸', role: 'father' }],
  categories: flatCats(),
  accounts,
};

test('转账：说出「从…到…」能认出两个账户', () => {
  const r = parseEntry('从银行卡转账500到微信', ctx);
  assert.equal(r.kind, 'transfer');
  assert.equal(r.amount, 500);
  assert.equal(r.fromAccountId, 'acc-bank');
  assert.equal(r.toAccountId, 'acc-wx');
});

test('转账：倒装语序也能对上调换', () => {
  const r = parseEntry('转账500到微信', ctx);
  assert.equal(r.kind, 'transfer');
  assert.equal(r.toAccountId, 'acc-wx');
  assert.equal(r.fromAccountId, null);
});

test('普通支出：带账户名时归到该账户', () => {
  const r = parseEntry('用现金买菜35元', ctx);
  assert.equal(r.kind, 'expense');
  assert.equal(r.categoryId, 'food-market');
  assert.equal(r.fromAccountId, 'acc-cash');
});

test('账户名不会污染备注', () => {
  const r = parseEntry('从银行卡转账500到微信', ctx);
  assert.ok(!/银行卡|微信/.test(r.note), `备注里残留了账户名：${r.note}`);
});

test('matchAccounts 单账户方向判断', () => {
  assert.equal(matchAccounts('从现金支出20', accounts).fromAccountId, 'acc-cash');
  assert.equal(matchAccounts('收到的钱进微信', accounts).toAccountId, 'acc-wx');
});

test('accountBalances：转账同时扣转出、加转入', () => {
  const list = [
    { kind: 'transfer', amount: 500, account_id: 'acc-bank', to_account_id: 'acc-wx' },
  ];
  const rows = accountBalances(list, accounts);
  const by = Object.fromEntries(rows.map((r) => [r.id, r.balance]));
  assert.equal(by['acc-bank'], -500);
  assert.equal(by['acc-wx'], 500);
  assert.equal(by['acc-cash'], 0);
});

test('accountBalances：收入支出借还报销各自的符号', () => {
  const list = [
    { kind: 'income', amount: 1000, account_id: 'acc-bank' },
    { kind: 'expense', amount: 300, account_id: 'acc-bank' },
    { kind: 'lend', amount: 200, account_id: 'acc-bank' },
    { kind: 'lend_return', amount: 200, account_id: 'acc-bank' },
    { kind: 'borrow', amount: 800, account_id: 'acc-cash' },
    { kind: 'borrow_return', amount: 300, account_id: 'acc-cash' },
    { kind: 'reimburse_back', amount: 120, account_id: 'acc-wx' },
  ];
  const rows = accountBalances(list, accounts);
  const by = Object.fromEntries(rows.map((r) => [r.id, r.balance]));
  assert.equal(by['acc-bank'], 700); // 1000 - 300 - 200 + 200
  assert.equal(by['acc-cash'], 500); // +800 - 300
  assert.equal(by['acc-wx'], 120);
});

test('accountBalances：初始余额作为起点，未知账户被忽略', () => {
  const withInit = [
    { id: 'acc-bank', name: '银行卡', kind: 'bank', initial_balance: 5000 },
  ];
  const list = [
    { kind: 'expense', amount: 300, account_id: 'acc-bank' },
    { kind: 'expense', amount: 999, account_id: 'acc-unknown' },
  ];
  const rows = accountBalances(list, withInit);
  assert.equal(rows[0].balance, 4700);
});
