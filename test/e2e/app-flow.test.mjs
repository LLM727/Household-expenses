/**
 * 整条链路的端到端测试：界面方法 → RemoteStore → HTTP → 真 Postgres。
 *
 * 和 remote-store.test.mjs 的区别：那个直接调数据层，这个从 App 的
 * submitAuth / submitFamily / doParse / saveDraft 入口进去，
 * 走的就是用户第一次使用时的真实路径。
 *
 *   npm i --no-save @electric-sql/pglite
 *   node test/e2e/app-flow.test.mjs
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
let inviteCode = '';

before(async () => {
  fake = await startFakeSupabase();
});

after(async () => {
  await fake?.close();
});

async function bootApp() {
  const root = new MiniEl();
  const store = new RemoteStore({
    url: fake.url,
    anonKey: fake.anonKey,
    storage: new MemStorage(),
  });
  const app = new App(root, store);
  await app.init();
  return { app, root, store };
}

test('第一次用：注册 → 建家 → 记一笔 → 流水、统计、邀请码都对', async () => {
  const { app, root } = await bootApp();

  // 1. 一进来是登录页
  assert.equal(app.loggedIn, false);
  assert.ok(root.has('登录'), '没看到登录页');

  // 2. 切到注册，填好，提交
  app.authMode = 'signup';
  app.render();
  assert.ok(root.has('id="auth-name"'), '注册页没有「你的称呼」输入框');
  root.fill('#auth-email', 'first@test.com');
  root.fill('#auth-password', 'pw123456');
  root.fill('#auth-name', '爸爸');
  await app.submitAuth();

  assert.equal(app.authError, '', `注册没成功：${app.authError}`);
  assert.ok(app.loggedIn, '注册完还是未登录');

  // 3. 注册后应该落在「建家 / 加入」页，而不是直接进记账页
  assert.equal(app.hasFamily, false);
  assert.ok(root.has('建一本家庭账'), '没停在建家页');
  root.fill('#family-name', '我们仨');
  root.fill('#family-display', '爸爸');
  root.fill('#family-role', 'father');
  await app.submitFamily();

  assert.equal(app.authError, '', `建家没成功：${app.authError}`);
  assert.ok(app.hasFamily, '建家后 profile.family_id 还是空的');
  assert.equal(app.store.family.name, '我们仨');
  assert.ok(app.store.categories.length >= 40, `默认分类没写入：${app.store.categories.length}`);
  assert.equal(app.store.accounts.length, 4);

  // 4. 说一句话记账
  await app.doParse('今天买菜35.5元');
  assert.ok(app.draft, '没生成草稿卡');
  assert.equal(Number(app.draft.amount), 35.5, `金额识别错了：${app.draft.amount}`);
  assert.equal(app.draft.kind, 'expense');
  await app.saveDraft();
  assert.equal(app.draft, null, '保存后草稿没清掉');
  assert.equal([...app.cache.values()].length, 1, '账目没进本地缓存');

  // 5. 流水页看得到
  app.tab = 'list';
  await app.refreshData();
  app.render();
  assert.ok(root.has('买菜'), '流水页没显示这笔记账');
  assert.ok(root.has('爸爸'), '流水页没显示「谁记的」');

  // 6. 统计页算得出来
  app.tab = 'stats';
  await app.refreshData();
  app.render();
  assert.ok(/35\.5/.test(root.innerHTML), '统计页没显示 35.5');
  assert.ok(root.has('<svg'), '统计页没出图');

  // 7. 我的页有邀请码，且是 6 位合法字符
  app.tab = 'me';
  await app.ensureFullHistory();
  app.render();
  inviteCode = app.store.family.invite_code;
  assert.match(inviteCode, /^[A-HJ-NP-Z2-9]{6}$/, `邀请码不对：${inviteCode}`);
  assert.ok(root.has(inviteCode), '我的页没显示邀请码');
});

test('第二个人：注册 → 用邀请码加入 → 看到同一本账并能记账', async () => {
  const { app, root } = await bootApp();

  app.authMode = 'signup';
  app.render();
  root.fill('#auth-email', 'second@test.com');
  root.fill('#auth-password', 'pw123456');
  root.fill('#auth-name', '妈妈');
  await app.submitAuth();
  assert.equal(app.authError, '', `注册没成功：${app.authError}`);

  // 切到「邀请码加入」
  app.familyMode = 'join';
  app.render();
  assert.ok(root.has('id="family-code"'), '加入页没有邀请码输入框');
  root.fill('#family-code', inviteCode.toLowerCase()); // 小写也要能用
  root.fill('#family-display', '妈妈');
  root.fill('#family-role', 'mother');
  await app.submitFamily();

  assert.equal(app.authError, '', `加入没成功：${app.authError}`);
  assert.ok(app.hasFamily);
  assert.equal(app.store.members.length, 2, `成员应该是 2 个，实际 ${app.store.members.length}`);

  // 看得到爸爸记的那笔（「买菜」是分类名，不是备注）
  const rows = await app.store.fetchTransactions('2000-01-01', '2100-12-31');
  assert.ok(rows.some((r) => Number(r.amount) === 35.5), '妈妈看不到爸爸记的账');

  // 自己也能记一笔
  await app.doParse('买水果20元');
  await app.saveDraft();
  const after = await app.store.fetchTransactions('2000-01-01', '2100-12-31');
  assert.equal(after.length, 2, `记完应该是 2 笔，实际 ${after.length}`);

  // 两个人记的账都在同一个家庭
  assert.ok(after.every((r) => r.family_id === app.store.family.id));
});

test('密码错：给中文提示，不是英文报错', async () => {
  const { app, root } = await bootApp();
  app.authMode = 'signin';
  app.render();
  root.fill('#auth-email', 'first@test.com');
  root.fill('#auth-password', 'wrong-password');
  await app.submitAuth();

  assert.equal(app.loggedIn, false, '密码错居然登录成功了');
  assert.match(app.authError, /邮箱或密码/, `提示不是中文：${app.authError}`);
  assert.ok(root.has(app.authError), '错误提示没显示在页面上');
});

test('别人家的邀请码：加入失败并给中文提示', async () => {
  const { app, root } = await bootApp();
  app.authMode = 'signup';
  app.render();
  root.fill('#auth-email', 'third@test.com');
  root.fill('#auth-password', 'pw123456');
  root.fill('#auth-name', '孩子');
  await app.submitAuth();

  app.familyMode = 'join';
  app.render();
  root.fill('#family-code', 'ZZZZZZ');
  root.fill('#family-display', '孩子');
  root.fill('#family-role', 'child');
  await app.submitFamily();

  assert.equal(app.hasFamily, false, '错误邀请码竟然加入了');
  assert.match(app.authError, /邀请码/, `提示不对：${app.authError}`);
});
