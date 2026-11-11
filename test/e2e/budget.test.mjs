/**
 * 端到端：预算（设预算 → 超支提醒）。
 *
 * 为什么单独一个文件：预算一直只被「绕过去」测过——之前的 e2e 直接调
 * `store.saveBudget()` 往库里塞一个预算，再断言统计页出现「已超支」。
 * 那验的是「有预算数据时页面会标红」，**没验过用户在界面上设预算这件事本身**。
 *
 * 而这一步之前是测不了的：假 DOM 的 `querySelectorAll()` 恒返回空数组，
 * `saveBudget()` 拿到 0 个输入框、一声不响什么也没做，测试还是绿的。
 * 这一轮先给假 DOM 补上属性选择器支持，才第一次真正走通「界面上设预算」。
 *
 *   npm i --no-save @electric-sql/pglite
 *   node test/e2e/budget.test.mjs
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeSupabase } from './fake-supabase.mjs';
import { MiniEl } from './mini-dom.mjs';
import { App } from '../../src/app.js';
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

before(async () => {
  fake = await startFakeSupabase();
});

after(async () => {
  await fake?.close();
});

let seq = 0;
async function bootFamily(tag) {
  seq += 1;
  const root = new MiniEl();
  const store = new RemoteStore({
    url: fake.url,
    anonKey: fake.anonKey,
    storage: new MemStorage(),
  });
  const app = new App(root, store);
  await app.init();
  app.authMode = 'signup';
  app.render();
  root.fill('#auth-email', `${tag}-${seq}@test.com`);
  root.fill('#auth-password', 'pw123456');
  root.fill('#auth-name', '爸爸');
  await app.submitAuth();
  assert.ok(app.loggedIn, `注册失败：${app.authError}`);
  root.fill('#family-name', '我们仨');
  root.fill('#family-display', '爸爸');
  root.fill('#family-role', 'father');
  await app.submitFamily();
  assert.ok(app.hasFamily, `建家失败：${app.authError}`);
  return { app, root, store };
}

async function addByText(app, root, sentence) {
  root.fill('#raw-text', sentence);
  await app.doParse(sentence);
  assert.ok(app.draft, `「${sentence}」没识别出草稿：${app.toastMsg}`);
  await app.saveDraft();
  await app.refreshData();
}

/** 打开「我的」页的预算区（用户真实的两步：切标签 → 点保存） */
function openBudgetPage(app) {
  app.tab = 'me';
  app.render();
}

/* ------------------------------------------------------------------ */

test('在界面上设家庭总预算：真的写进了数据库，刷新后还在', async () => {
  const { app, root, store } = await bootFamily('budget-set');
  openBudgetPage(app);

  // 页面上必须有总预算输入框，否则用户根本无处可填
  const inputs = root.querySelectorAll('[data-budget-input]');
  assert.ok(inputs.length >= 1, '「我的」页上看不到预算输入框');
  assert.ok(
    inputs.some((c) => (c.dataset.budgetInput || '') === ''),
    '没有「本月总预算」那个输入框',
  );

  root.fillBudget(null, 3000); // categoryId=null → 家庭总预算
  await app._handleAction('save-budget', {}, {});

  const saved = await store.listBudgets(app.budgetMonth);
  const family = saved.find((b) => !b.category_id);
  assert.ok(family, '界面上点了保存，数据库里却没有总预算');
  assert.equal(Number(family.amount), 3000, `存的金额不对：${family.amount}`);

  // 重新加载（相当于换台手机打开），预算还在
  await app.refreshData();
  const again = await store.listBudgets(app.budgetMonth);
  assert.equal(Number(again.find((b) => !b.category_id)?.amount), 3000, '刷新后预算丢了');
});

test('在界面上按分类设预算：只写这一条，不动总预算', async () => {
  const { app, root, store } = await bootFamily('budget-cat');
  openBudgetPage(app);

  // 预算输入框只列大类（餐饮、交通…），小类的钱会往上汇总，所以这里用「餐饮」
  const dining = store.categories.find((c) => c.name === '餐饮' && !c.parent_id);
  assert.ok(dining, '默认分类里没有「餐饮」大类');
  assert.ok(
    root.querySelectorAll('[data-budget-input]').some((c) => c.dataset.budgetInput === dining.id),
    '「餐饮」没有预算输入框',
  );

  root.fillBudget(null, 5000);
  await app._handleAction('save-budget', {}, {});
  root.fillBudget(dining.id, 400);
  await app._handleAction('save-budget', {}, {});

  const saved = await store.listBudgets(app.budgetMonth);
  assert.equal(Number(saved.find((b) => !b.category_id)?.amount), 5000, '总预算被分类预算覆盖了');
  assert.equal(
    Number(saved.find((b) => b.category_id === dining.id)?.amount),
    400,
    '分类预算没存上',
  );
});

test('设了预算又清空：预算被删掉，不会留下一条 0 元预算', async () => {
  const { app, root, store } = await bootFamily('budget-clear');
  openBudgetPage(app);

  root.fillBudget(null, 1000);
  await app._handleAction('save-budget', {}, {});
  assert.equal((await store.listBudgets(app.budgetMonth)).length, 1, '预算没设上');

  // 用户改主意了，把框清空再保存
  root.fillBudget(null, '');
  await app._handleAction('save-budget', {}, {});
  const after = await store.listBudgets(app.budgetMonth);
  assert.equal(after.length, 0, `清空后还剩 ${after.length} 条预算（0 元预算会让统计页一直显示 0/0）`);
});

test('超支：给大类设的预算，钱花在小类上也要算进去', async () => {
  const { app, root } = await bootFamily('budget-over');

  // 给「餐饮」设 30 块预算
  openBudgetPage(app);
  const dining = app.store.categories.find((c) => c.name === '餐饮' && !c.parent_id);
  assert.ok(dining, '默认分类里没有「餐饮」大类');
  root.fillBudget(dining.id, 30);
  await app._handleAction('save-budget', {}, {});

  // 再记一笔 35.5 的买菜（走真实输入框）——它会落到小类「餐饮/买菜」上
  app.tab = 'record';
  app.render();
  await addByText(app, root, '今天买菜35.5元');

  app.tab = 'stats';
  app.render();
  // 这一条是重点：钱记在小类上，大类预算必须能统计到，否则「设了预算却永远不超支」
  assert.ok(root.has('已超支'), '钱花在小类上，大类的预算没算进去（或根本没提示超支）');
  assert.ok(root.has('餐饮'), '提示里没说是哪个分类超了');
  // 超支金额应该是 35.5 - 30 = 5.5
  assert.ok(root.has('5.50'), `没显示超了多少钱；页面上是：${root.innerHTML.slice(0, 300)}`);
});

test('小类预算只管自己：给「餐饮」设 1000、在「买菜」花 800，不该显示超支', async () => {
  const { app, root } = await bootFamily('budget-scope');
  openBudgetPage(app);
  const dining = app.store.categories.find((c) => c.name === '餐饮' && !c.parent_id);
  root.fillBudget(dining.id, 1000);
  await app._handleAction('save-budget', {}, {});

  app.tab = 'record';
  app.render();
  await addByText(app, root, '今天买菜800元');

  app.tab = 'stats';
  app.render();
  assert.ok(!root.has('已超支'), '800 / 1000 也报超支，说明汇总口径算错了');
  assert.ok(root.has('200.00'), '没显示还剩 200');
});

test('没超支时不能说「已超支」：预算 1000 花了 35.5', async () => {
  const { app, root } = await bootFamily('budget-ok');
  openBudgetPage(app);
  root.fillBudget(null, 1000);
  await app._handleAction('save-budget', {}, {});

  app.tab = 'record';
  app.render();
  await addByText(app, root, '今天买菜35.5元');

  app.tab = 'stats';
  app.render();
  assert.ok(!root.has('已超支'), '没超支却显示「已超支」——这会让人以为钱花超了');
  assert.ok(root.has('还剩'), '没超支时应该显示还剩多少');
});
