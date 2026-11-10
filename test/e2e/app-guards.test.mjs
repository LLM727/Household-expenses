/**
 * 界面层的行为守卫：防重复提交、切回前台自动刷新。
 *
 * 这两件事都属于「平时看不出问题，出事时数据就错了」的类型：
 *   - 双击「确认入账」→ 同一笔账记两条，月底对不上；
 *   - 手机切到后台再切回来 → 另一台手机记的账看不见，以为对方没记。
 *
 * 用假 document 把 visibilitychange 接出来，就能在没有浏览器的情况下验证。
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
const listeners = {};

before(async () => {
  fake = await startFakeSupabase();
  // 假 document：把监听器接出来，测试里手动触发
  globalThis.document = {
    visibilityState: 'visible',
    addEventListener(type, fn) {
      listeners[type] = fn;
    },
  };
});

after(async () => {
  delete globalThis.document;
  await fake?.close();
});

/** 起一个 App，注册并建好家，返回可直接记账的状态 */
async function bootReadyFamily(email) {
  const root = new MiniEl();
  const store = new RemoteStore({ url: fake.url, anonKey: fake.anonKey, storage: new MemStorage() });
  const app = new App(root, store);
  await app.init();

  app.authMode = 'signup';
  app.render();
  root.fill('#auth-email', email);
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

/** 模拟另一台手机：同一个账号登录，记一笔 */
async function otherDevice(email) {
  const store = new RemoteStore({ url: fake.url, anonKey: fake.anonKey, storage: new MemStorage() });
  await store.signIn(email, 'pw123456');
  await store.loadProfile();
  return store;
}

test('双击「确认入账」只能记一条', async () => {
  const { app, store } = await bootReadyFamily('double@test.com');
  await app.doParse('今天买菜35.5元');
  assert.ok(app.draft, '没生成草稿');

  // 像手抖那样连点两下：第一下还没结束就点第二下
  const first = app.saveDraft();
  const second = app.saveDraft();
  await Promise.all([first, second]);

  const rows = await store.fetchTransactions('2000-01-01', '2100-12-31');
  assert.equal(rows.length, 1, `双击记成了 ${rows.length} 条账`);
});

test('切回前台会自动重新拉数据：另一台手机记的账能看到', async () => {
  const { app, store } = await bootReadyFamily('visible@test.com');
  assert.equal([...app.cache.values()].length, 0, '刚建家不该有账');

  // 另一台手机记一笔
  const other = await otherDevice('visible@test.com');
  await other.addTransaction({ kind: 'expense', amount: 88, occurred_on: '2026-11-07', note: '另一台手机' });

  // 本机还没刷新，缓存里当然没有
  assert.equal([...app.cache.values()].length, 0);

  // 切回前台 → 应该自动拉一次
  globalThis.document.visibilityState = 'visible';
  await listeners.visibilitychange();

  const cached = [...app.cache.values()];
  assert.equal(cached.length, 1, '切回前台后没拉到另一台手机的账');
  assert.equal(Number(cached[0].amount), 88);
  const fresh = await store.fetchTransactions('2000-01-01', '2100-12-31');
  assert.equal(fresh.length, 1);
});

test('切到后台（hidden）不触发刷新', async () => {
  const { app } = await bootReadyFamily('hidden@test.com');
  globalThis.document.visibilityState = 'hidden';
  const result = listeners.visibilitychange();
  assert.equal(result, undefined, 'hidden 时不该去拉数据');
  assert.equal([...app.cache.values()].length, 0);
});

test('还没登录时切回前台不会炸', async () => {
  const root = new MiniEl();
  const store = new RemoteStore({ url: fake.url, anonKey: fake.anonKey, storage: new MemStorage() });
  const app = new App(root, store);
  await app.init();
  assert.equal(app.loggedIn, false);

  globalThis.document.visibilityState = 'visible';
  await listeners.visibilitychange();
  assert.ok(root.has('登录'), '应该还在登录页');
});

test('退出登录：界面立刻回到登录页，账目不再显示', async () => {
  const { app, root } = await bootReadyFamily('signout@test.com');
  await app.doParse('今天买菜35.5元');
  await app.saveDraft();
  app.tab = 'list';
  await app.refreshData();
  app.render();
  assert.ok(root.has('买菜'), '记账后流水页应该有这笔');

  await app._handleAction('signout', null, null); // 走界面上的真实分支

  assert.equal(app.loggedIn, false, '退出后仍被视为已登录');
  assert.ok(root.has('登录'), '退出后应该看到登录页');
  assert.ok(!root.has('买菜'), '退出后屏幕上不该还留着账目');
  assert.equal(app.cache.size, 0, '本地缓存没清空');
});
