/**
 * 登录态过期的测试。
 *
 * Supabase 的 access token 默认 1 小时过期。这个路径在单元测试里永远走不到
 * （没有谁会等一小时），但真实使用中早晚会遇到：第二天早上打开 App、
 * 或者手机放了一夜。所以必须能自动化验证。
 *
 * 要验的是两件事：
 *   1. 过期但有 refresh_token → 自动续期，用户无感，继续用；
 *   2. 续期失败（refresh_token 也失效了）→ 必须**明确报错并回到登录页**，
 *      绝不能悄悄用匿名身份查一遍、然后显示「这个月还没有账目」。
 *      后者会让人以为账本被清空了，比报错严重得多。
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
let seeded;

before(async () => {
  fake = await startFakeSupabase();
  // 先建一个带数据的家庭，后面每个测试各自克隆一份「过期会话」去打它
  seeded = new RemoteStore({ url: fake.url, anonKey: fake.anonKey, storage: new MemStorage() });
  await seeded.signUp('owner@test.com', 'pw123456', '爸爸');
  await seeded.createFamily('我们仨', '爸爸', 'father');
  await seeded.addTransaction({
    kind: 'expense',
    amount: 35.5,
    occurred_on: '2026-11-05',
    note: '买菜',
  });
});

after(async () => {
  await fake?.close();
});

/** 用一个会话造一个「已经过期」的客户端 */
function clientWithSession(session) {
  const store = new RemoteStore({ url: fake.url, anonKey: fake.anonKey, storage: new MemStorage() });
  store.client._writeSession(session);
  return store;
}

test('token 过期但 refresh_token 有效：自动续期，用户无感', async () => {
  const oldSession = JSON.parse(JSON.stringify(seeded.client.session));
  const store = clientWithSession({
    ...oldSession,
    expires_at: Date.now() - 1000, // 已经过期
  });

  const rows = await store.fetchTransactions('2000-01-01', '2100-12-31');

  assert.equal(rows.length, 1, '续期后应该能正常查到账目');
  assert.equal(Number(rows[0].amount), 35.5);
  assert.notEqual(store.client.session.access_token, oldSession.access_token, 'access_token 没换成新的');
  assert.ok(store.client.session.expires_at > Date.now(), '新 token 的过期时间没更新');
});

test('refresh_token 也失效：必须明确报「登录过期」，不能静默返回空账本', async () => {
  const oldSession = JSON.parse(JSON.stringify(seeded.client.session));
  const store = clientWithSession({
    ...oldSession,
    refresh_token: 'this-token-no-longer-exists',
    expires_at: Date.now() - 1000,
  });

  await assert.rejects(
    () => store.fetchTransactions('2000-01-01', '2100-12-31'),
    /登录.*过期|重新登录/,
    '续期失败时必须抛错——悄悄返回空数组会让人以为账本被清空了',
  );
  assert.equal(store.client.session, null, '续期失败后应该清掉本地会话，回到登录页');
});

test('续期失败后不会卡死：再次调用直接走登录页，不再反复报错', async () => {
  const oldSession = JSON.parse(JSON.stringify(seeded.client.session));
  const store = clientWithSession({
    ...oldSession,
    refresh_token: 'also-gone',
    expires_at: Date.now() - 1000,
  });

  await assert.rejects(() => store.fetchTransactions('2000-01-01', '2100-12-31'));
  // 会话已清空：后续调用不会再抛错（交给界面判断「未登录」）
  const after = await store.fetchTransactions('2000-01-01', '2100-12-31');
  assert.deepEqual(after, []);
});

test('服务器判定 token 无效（401）：清掉本地会话，别让用户一直撞墙', async () => {
  const store = clientWithSession({
    access_token: 'acc_never_issued_by_this_server',
    refresh_token: 'whatever',
    expires_at: Date.now() + 3600 * 1000, // 本地以为还没过期，但服务器不认
    user: { id: '00000000-0000-0000-0000-000000000000', email: 'ghost@test.com' },
  });

  await assert.rejects(
    () => store.fetchTransactions('2000-01-01', '2100-12-31'),
    /JWT|登录|过期/i,
    '服务器不认 token 时必须报错',
  );
  assert.equal(store.client.session, null, '401 之后应该清掉本地会话，界面才能回到登录页');
});

test('界面表现：续期失败后回到登录页，而不是显示一本空账', async () => {
  const { App } = await import('../../src/app.js');
  const { MiniEl } = await import('./mini-dom.mjs');

  const root = new MiniEl();
  const store = clientWithSession({
    ...JSON.parse(JSON.stringify(seeded.client.session)),
    refresh_token: 'long-gone',
    expires_at: Date.now() - 1000,
  });
  const app = new App(root, store);
  await app.init();

  assert.equal(app.loggedIn, false, '过期后应视为未登录');
  assert.ok(root.has('登录'), '应该停在登录页');
  assert.ok(!root.has('还没有账目'), '绝不能显示「还没有账目」——那会让人以为账本被清空了');
  assert.match(app.authError, /登录|过期/, `登录页上应该有原因提示：${app.authError}`);
});
