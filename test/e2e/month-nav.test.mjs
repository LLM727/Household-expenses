/**
 * 端到端：翻月份。
 *
 * 为什么单独一个文件：翻上一月 / 下一月是这个应用里最高频的浏览动作
 * （「上个月花了多少」），但之前没有任何端到端测试碰过它。
 * 已有的 app-guards 只测了「补录到别的月份时视图跟过去」，没测过
 * 「翻回去看，看到的到底是不是那个月的账」。
 *
 * 这里的断言全部用绝对数字（35.5 / 38 / 73.5），不是「有没有变」这种相对说法——
 * 相对说法会被一个恒定偏移糊弄过去。
 *
 *   npm i --no-save @electric-sql/pglite
 *   node test/e2e/month-nav.test.mjs
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeSupabase } from './fake-supabase.mjs';
import { MiniEl } from './mini-dom.mjs';
import { App } from '../../src/app.js';
import { RemoteStore } from '../../src/store.js';
import * as A from '../../src/analytics.js';
import * as U from '../../src/utils.js';

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

/** 走真实输入框记一笔；occurredOn 传了就当作补录 */
async function addByText(app, root, sentence, occurredOn) {
  app.tab = 'record';
  app.render();
  root.fill('#raw-text', sentence);
  await app.doParse(sentence);
  assert.ok(app.draft, `「${sentence}」没识别出草稿：${app.toastMsg}`);
  if (occurredOn) app.draft.occurredOn = occurredOn;
  await app.saveDraft();
  await app.refreshData();
}

/** 当前月账上所有条目（直接问数据库） */
async function rowsFromDb(store, month) {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  const all = await store.fetchTransactions(`${month}-01`, `${month}-${String(last).padStart(2, '0')}`);
  return all.filter((t) => String(t.occurred_on).slice(0, 7) === month);
}

/* ------------------------------------------------------------------ */

test('翻到上一月：看到的是上个月的账，本月那笔不能混进来', async () => {
  const { app, root, store } = await bootFamily('nav');
  const cur = app.month;
  const prev = U.shiftMonth(cur, -1);

  await addByText(app, root, '今天买菜35.5元'); // 本月
  await addByText(app, root, '今天打车38', `${prev}-15`); // 补录到上月

  // 补录完视图应该已经跟到上月（app-guards 里另有一条专测这个）
  assert.equal(app.month, prev, '补录到上月后视图没跟过去');

  // 两个月的合计各自独立
  assert.equal(A.totals(await rowsFromDb(store, prev)).expense, 38, '上个月合计不对');
  assert.equal(A.totals(await rowsFromDb(store, cur)).expense, 35.5, '本月合计被上个月的账污染了');

  // 翻到本月：只能看到 35.5 那笔
  await app._handleAction('month-next', {}, {});
  assert.equal(app.month, cur, '翻下一月没回到本月');
  app.tab = 'list';
  app.render();
  assert.ok(root.has('35.50'), '本月那笔在流水页上不见了');
  assert.ok(root.has('买菜'), '本月那笔的备注不见了');
  assert.ok(!root.has('38.00'), '翻到本月还显示着上个月的账');
  assert.ok(!root.has('打车'), '翻到本月还显示着上个月的备注');

  // 再翻回上月：只能看到 38 那笔
  await app._handleAction('month-prev', {}, {});
  app.tab = 'list';
  app.render();
  assert.ok(root.has('38.00'), '上个月那笔在流水页上不见了');
  assert.ok(!root.has('35.50'), '翻到上月还显示着本月的账');
});

test('翻月份不改变数据：来回翻一圈，账本和合计都得原样', async () => {
  const { app, root, store } = await bootFamily('nav-roundtrip');
  const cur = app.month;

  await addByText(app, root, '今天买菜35.5元');
  await addByText(app, root, '今天话费50元');

  const before = await rowsFromDb(store, cur);
  assert.equal(A.totals(before).expense, 85.5);

  // 往回翻 6 个月再翻回来
  for (let i = 0; i < 6; i += 1) await app._handleAction('month-prev', {}, {});
  for (let i = 0; i < 6; i += 1) await app._handleAction('month-next', {}, {});

  assert.equal(app.month, cur, '来回翻之后没回到原来的月份');
  const after = await rowsFromDb(store, cur);
  assert.equal(after.length, before.length, '翻月份把账目改多了或改少了');
  assert.equal(A.totals(after).expense, 85.5, '翻月份改了合计');
});

test('翻到没有账的月份：合计为 0，页面说「还没有数据」而不是空白一片', async () => {
  const { app, root } = await bootFamily('nav-empty');
  const cur = app.month;
  await addByText(app, root, '今天买菜35.5元');

  // 往前翻 3 个月，那里什么都没有
  for (let i = 0; i < 3; i += 1) await app._handleAction('month-prev', {}, {});
  assert.equal(app.month, U.shiftMonth(cur, -3));

  app.tab = 'stats';
  app.render();
  assert.ok(root.has('0.00'), '空月份没显示 0.00 合计');
  assert.ok(root.has('这个月还没有数据'), '空月份的饼图位置没给出说明');
  assert.ok(!root.has('NaN'), '空月份渲染出了 NaN');

  // 本月那笔不该出现在这个空月份里
  app.tab = 'list';
  app.render();
  assert.ok(!root.has('35.50'), '翻到空月份还显示着本月的账');
});

test('上个月没账时，环比不能编一个「↑1%」出来', async () => {
  const { app, root } = await bootFamily('nav-cmp');
  await addByText(app, root, '今天买菜35.5元'); // 上月是空的

  app.tab = 'stats';
  app.render();
  const html = root.innerHTML;
  assert.ok(!/Infinity/.test(html), '上月没账时环比渲染出了 Infinity');
  assert.ok(!/NaN/.test(html), '上月没账时环比渲染出了 NaN');
  // 除零在数学上没有值。原来的实现返回 1，界面就显示「支出 ↑1%」——
  // 用户第一个月记账时每一栏都写着 ↑1%，看着像只涨了 1%，其实是上个月根本没账。
  assert.ok(!root.has('↑1%'), '上个月没账，环比却显示「↑1%」（编出来的百分比）');
  assert.ok(!root.has('↓1%'), '上个月没账，环比却显示「↓1%」（编出来的百分比）');
  assert.ok(root.has('上月没有'), '上个月没账时，环比位置应该说「上月没有」');
});

test('上月有账时环比照常算百分比', async () => {
  const { app, root } = await bootFamily('nav-cmp2');
  const prev = U.shiftMonth(app.month, -1);
  // 上月 100，本月 150 → ↑50%
  await addByText(app, root, '今天打车100', `${prev}-10`);
  await addByText(app, root, '今天打车150');

  app.month = U.shiftMonth(prev, 1);
  await app.refreshData();
  app.tab = 'stats';
  app.render();
  assert.ok(root.has('↑50%'), `环比算错了；页面上是：${root.innerHTML.slice(0, 400)}`);
});
