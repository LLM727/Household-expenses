/**
 * 端到端：记账之后的「改」和「删」。
 *
 * 为什么单独一个文件：之前的端到端测试主要验「记进去的那一笔对不对」，
 * 但家里人记账最常见的后续动作是**记错了要改**和**记重了要删**。
 * 这两条路径一直是空白——离线测试只验了「点编辑能进编辑态」，
 * 从没验过「改完保存，账上真的变了」。删除更是完全没测过。
 *
 *   npm i --no-save @electric-sql/pglite
 *   node test/e2e/crud.test.mjs
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeSupabase } from './fake-supabase.mjs';
import { MiniEl } from './mini-dom.mjs';
import { App } from '../../src/app.js';
import { RemoteStore } from '../../src/store.js';
import * as A from '../../src/analytics.js';

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

/** 每次用新邮箱建一个新家，保证测试之间互不干扰 */
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

/** 走真实输入框记一笔，返回这一笔的 id */
async function addByText(app, root, sentence) {
  root.fill('#raw-text', sentence);
  await app.doParse(sentence);
  assert.ok(app.draft, `「${sentence}」没识别出草稿：${app.toastMsg}`);
  await app.saveDraft();
  await app.refreshData();
  const row = [...app.cache.values()].find((t) => (t.raw_input || '') === sentence);
  assert.ok(row, `「${sentence}」存进去后在缓存里找不到`);
  return row;
}

/** 当前月账上所有条目（直接问数据库，不看缓存） */
async function rowsFromDb(store, month) {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  const list = await store.fetchTransactions(`${month}-01`, `${month}-${String(last).padStart(2, '0')}`);
  return list.filter((t) => String(t.occurred_on).slice(0, 7) === month);
}

/* ------------------------------------------------------------------ */

test('改一笔账：金额、备注、分类都改掉，数据库里是新值，合计跟着变', async () => {
  const { app, root, store } = await bootFamily('edit');
  const month = app.month;

  const tx = await addByText(app, root, '今天买菜35.5元');
  assert.equal(A.totals(await rowsFromDb(store, month)).expense, 35.5);

  // 用户发现记错了：其实是 53.5，买的是水果
  const fruit = store.categories.find((c) => /水果/.test(c.name)) || store.categories.find((c) => c.kind === 'expense');
  await app._handleAction('edit-tx', { dataset: { id: tx.id } }, {});
  assert.equal(app.editing, tx.id, '没进入编辑态');
  app.draft.amount = 53.5;
  app.draft.note = '水果';
  app.draft.categoryId = fruit.id;
  await app.saveDraft();

  const after = await rowsFromDb(store, month);
  assert.equal(after.length, 1, `改完不该多出一条账，现在有 ${after.length} 条`);
  assert.equal(Number(after[0].amount), 53.5, `金额没改掉，还是 ${after[0].amount}`);
  assert.equal(after[0].note, '水果', `备注没改掉：${after[0].note}`);
  assert.equal(after[0].category_id, fruit.id, '分类没改掉');
  assert.equal(A.totals(after).expense, 53.5, '合计没跟着改');

  // 改完要退出编辑态，否则用户再点「确认入账」会又改一遍
  assert.equal(app.draft, null, '保存后草稿没清掉');
  assert.equal(app.editing, null, '保存后还停在编辑态');
});

test('改一笔账：改了日期就换月，本月合计要减掉它', async () => {
  const { app, root, store } = await bootFamily('move');
  const month = app.month;
  const [y, m] = month.split('-').map(Number);
  const prev = new Date(y, m - 2, 1);
  const prevMonth = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;

  const tx = await addByText(app, root, '今天打车38');
  assert.equal(A.totals(await rowsFromDb(store, month)).expense, 38);

  await app._handleAction('edit-tx', { dataset: { id: tx.id } }, {});
  app.draft.occurredOn = `${prevMonth}-15`;
  await app.saveDraft();

  assert.equal(
    A.totals(await rowsFromDb(store, month)).expense,
    0,
    '把账改到上个月后，本月合计里还留着它',
  );
  const moved = A.totals(await rowsFromDb(store, prevMonth));
  assert.equal(moved.expense, 38, '改到上个月的那笔没出现在上个月');
});

test('删一笔账：数据库里没了，合计掉回去，页面上也不再出现', async () => {
  const { app, root, store } = await bootFamily('del');
  const month = app.month;

  const a = await addByText(app, root, '今天买菜35.5元');
  await addByText(app, root, '今天打车38');
  assert.equal(A.totals(await rowsFromDb(store, month)).expense, 73.5);

  // 浏览器里 confirm 是全局函数；Node 里没有，删之前必须点「确定」
  const origConfirm = globalThis.confirm;
  globalThis.confirm = () => true;
  try {
    await app._handleAction('delete-tx', { dataset: { id: a.id } }, {});
  } finally {
    if (origConfirm === undefined) delete globalThis.confirm;
    else globalThis.confirm = origConfirm;
  }

  const after = await rowsFromDb(store, month);
  assert.equal(after.length, 1, `删完还剩 ${after.length} 条，应该只剩 1 条`);
  assert.notEqual(after[0].id, a.id, '删掉的那条还在账上');
  assert.equal(A.totals(after).expense, 38, '合计没掉回去');

  // 缓存和页面也不能再显示它
  assert.ok(!app.cache.has(a.id), '缓存里还留着已删的账');
  app.tab = 'ledger';
  app.render();
  assert.ok(!root.has('35.50'), '流水页还在显示已删除的那笔');
  assert.ok(!root.has('买菜'), '流水页还在显示已删除的那笔的备注');
});

test('删除时点「取消」：账目必须原样留着', async () => {
  const { app, root, store } = await bootFamily('cancel');
  const month = app.month;

  const tx = await addByText(app, root, '今天买菜35.5元');

  const origConfirm = globalThis.confirm;
  globalThis.confirm = () => false; // 用户在确认框上点了「取消」
  try {
    await app._handleAction('delete-tx', { dataset: { id: tx.id } }, {});
  } finally {
    if (origConfirm === undefined) delete globalThis.confirm;
    else globalThis.confirm = origConfirm;
  }

  const after = await rowsFromDb(store, month);
  assert.equal(after.length, 1, '点了取消，账目还是被删了');
  assert.equal(Number(after[0].amount), 35.5);
  assert.equal(A.totals(after).expense, 35.5);
});

test('自己加分类：新关键词能记账，且金额不受影响', async () => {
  const { app, root, store } = await bootFamily('cat');

  // 加一个二级分类，挂在「餐饮」下面，关键词「奶茶」
  const dining = store.categories.find((c) => c.name === '餐饮' && !c.parent_id)
    || store.categories.find((c) => /餐饮/.test(c.name));
  assert.ok(dining, '默认分类里没有「餐饮」大类');

  // 分类管理默认是收起的，先到「我的」页把它展开——走用户真实的两步
  app.tab = 'me';
  app.render();
  await app._handleAction('toggle-cat-manager', {}, {});

  root.fill('#new-cat-name', '奶茶');
  root.fill('#new-cat-kind', 'expense');
  root.fill('#new-cat-parent', dining.id);
  root.fill('#new-cat-words', '奶茶,喜茶,珍珠');
  await app.addCategory();
  await app.refreshData();
  const added = store.categories.find((c) => c.name === '奶茶');
  assert.ok(added, '新分类没加进去');
  assert.equal(added.parent_id, dining.id, '新分类没挂到「餐饮」下面');
  assert.deepEqual(added.keywords, ['奶茶', '喜茶', '珍珠'], `关键词没存对：${JSON.stringify(added.keywords)}`);

  // 回到记账页再记一笔——分类管理在「我的」页，记账页才有输入框
  app.tab = 'record';
  app.render();

  // 用新关键词记一笔，应该落到新分类上
  const tx = await addByText(app, root, '今天买奶茶18元');
  assert.equal(tx.category_id, added.id, '说了「奶茶」却没落到新分类上');
  assert.equal(Number(tx.amount), 18, '金额被分类关键词影响了');
});
