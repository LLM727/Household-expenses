/**
 * 远程层测试：用假的 fetch 验证 Supabase 客户端的请求构造（地址、方法、请求头、请求体），
 * 以及 RemoteStore 的「建家 → 写入默认分类和账户」流程。
 * 全部离线，不需要真的 Supabase 项目。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { SupabaseClient, SupabaseError } from '../src/supabase.js';
import { RemoteStore } from '../src/store.js';

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

const URL_BASE = 'https://demo.supabase.co';
const KEY = 'test-anon-key';

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  };
}

function makeFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const parsed = new URL(url);
    const record = {
      url,
      path: parsed.pathname,
      query: Object.fromEntries(parsed.searchParams.entries()),
      method: init.method || 'GET',
      headers: init.headers || {},
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(record);
    const result = handler(record, calls);
    if (result instanceof Error) throw result;
    return result ?? jsonResponse(200, null);
  };
  fn.calls = calls;
  return fn;
}

function newClient(fetchImpl, storage = new MemStorage()) {
  globalThis.fetch = fetchImpl;
  return new SupabaseClient({ url: URL_BASE, anonKey: KEY, storage });
}

const authPayload = {
  access_token: 'access-abc',
  refresh_token: 'refresh-abc',
  expires_in: 3600,
  user: { id: 'user-1', email: 'a@b.com' },
};

test('登录：地址、方法、请求体、apikey 正确', async () => {
  const f = makeFetch((rec) => {
    if (rec.path === '/auth/v1/token') return jsonResponse(200, authPayload);
    return null;
  });
  const client = newClient(f);
  await client.signIn('a@b.com', 'secret1');

  const call = f.calls[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.path, '/auth/v1/token');
  assert.equal(call.query.grant_type, 'password');
  assert.equal(call.headers.apikey, KEY);
  assert.deepEqual(call.body, { email: 'a@b.com', password: 'secret1' });
  assert.equal(client.userId, 'user-1');
  assert.ok(client.session.expires_at > Date.now());
});

test('注册但项目开启邮箱确认：给出可读提示', async () => {
  const f = makeFetch(() => jsonResponse(200, { id: 'user-1', email: 'a@b.com' }));
  const client = newClient(f);
  await assert.rejects(() => client.signUp('a@b.com', 'secret1', '爸爸'), (err) => {
    assert.ok(err instanceof SupabaseError);
    assert.equal(err.code, 'email_confirmation_required');
    return true;
  });
});

test('查询构造：select / 区间过滤 / 排序 / 分页都进 URL', async () => {
  const f = makeFetch(() => jsonResponse(200, []));
  const client = newClient(f);
  client._writeSession({ access_token: 't', refresh_token: 'r', expires_at: Date.now() + 1e6, user: authPayload.user });

  await client.table('transactions', {
    select: '*',
    filters: { occurred_on: 'gte.2026-11-01', and: '(occurred_on.lte.2026-11-30)' },
    order: 'occurred_on.desc,created_at.desc',
    limit: 50,
  });

  const call = f.calls[0];
  assert.equal(call.method, 'GET');
  assert.equal(call.path, '/rest/v1/transactions');
  assert.equal(call.query.select, '*');
  assert.equal(call.query.occurred_on, 'gte.2026-11-01');
  assert.equal(call.query.and, '(occurred_on.lte.2026-11-30)');
  assert.equal(call.query.order, 'occurred_on.desc,created_at.desc');
  assert.equal(call.query.limit, '50');
  assert.equal(call.headers.Authorization, 'Bearer t');
});

test('写入：POST 默认带 return=representation', async () => {
  const f = makeFetch(() => jsonResponse(201, [{ id: 'tx-1' }]));
  const client = newClient(f);
  client._writeSession({ access_token: 't', refresh_token: 'r', expires_at: Date.now() + 1e6, user: authPayload.user });

  const rows = await client.table('transactions', { method: 'POST', body: { amount: 12 } });
  assert.deepEqual(rows, [{ id: 'tx-1' }]);
  assert.equal(f.calls[0].method, 'POST');
  assert.equal(f.calls[0].headers.Prefer, 'return=representation');
  assert.deepEqual(f.calls[0].body, { amount: 12 });
});

test('令牌过期会自动刷新后再发请求', async () => {
  const f = makeFetch((rec) => {
    if (rec.path === '/auth/v1/token') return jsonResponse(200, { ...authPayload, access_token: 'new-token' });
    return jsonResponse(200, []);
  });
  const client = newClient(f);
  client._writeSession({
    access_token: 'old-token',
    refresh_token: 'refresh-abc',
    expires_at: Date.now() - 1000,
    user: authPayload.user,
  });

  await client.table('families', { select: '*' });

  assert.equal(f.calls[0].query.grant_type, 'refresh_token');
  const dataCall = f.calls[1];
  assert.equal(dataCall.path, '/rest/v1/families');
  assert.equal(dataCall.headers.Authorization, 'Bearer new-token');
});

test('服务端错误会变成带 message 的 SupabaseError', async () => {
  const f = makeFetch(() => jsonResponse(400, { message: 'Invalid login credentials', code: 'invalid_grant' }));
  const client = newClient(f);
  await assert.rejects(() => client.signIn('a@b.com', 'nope'), (err) => {
    assert.ok(err instanceof SupabaseError);
    assert.equal(err.message, 'Invalid login credentials');
    assert.equal(err.status, 400);
    return true;
  });
});

test('RemoteStore：建家后自动写入默认分类与账户', async () => {
  const state = {
    familyId: 'fam-1',
    postedCategories: [],
    postedAccounts: [],
  };

  const f = makeFetch((rec) => {
    // 建家
    if (rec.path === '/rest/v1/rpc/create_family') {
      return jsonResponse(200, [{ id: state.familyId, name: '我的家', invite_code: 'K3M9QP' }]);
    }
    // 写入分类：父级返回带 id 的行，子级只回空
    if (rec.path === '/rest/v1/categories' && rec.method === 'POST') {
      const rows = rec.body;
      state.postedCategories.push(...rows);
      return jsonResponse(201, rows.map((r, i) => ({ ...r, id: `${r.parent_id ? 'child' : 'parent'}-${i}` })));
    }
    if (rec.path === '/rest/v1/accounts' && rec.method === 'POST') {
      state.postedAccounts.push(...rec.body);
      return jsonResponse(201, []);
    }
    // 读家庭成员档案
    if (rec.path === '/rest/v1/members' && rec.method === 'GET') {
      return jsonResponse(200, [{ id: 'user-1', family_id: state.familyId, display_name: '爸爸', role: 'father' }]);
    }
    if (rec.path === '/rest/v1/families') {
      return jsonResponse(200, [{ id: state.familyId, name: '我的家', invite_code: 'K3M9QP' }]);
    }
    if (rec.path === '/rest/v1/categories' && rec.method === 'GET') {
      return jsonResponse(200, []);
    }
    if (rec.path === '/rest/v1/accounts' && rec.method === 'GET') {
      return jsonResponse(200, []);
    }
    return jsonResponse(200, []);
  });

  const storage = new MemStorage();
  globalThis.fetch = f;
  const store = new RemoteStore({ url: URL_BASE, anonKey: KEY, storage });
  store.client._writeSession({
    access_token: 't', refresh_token: 'r', expires_at: Date.now() + 1e6, user: authPayload.user,
  });

  await store.createFamily('我的家', '爸爸', 'father');

  assert.equal(store.family.id, 'fam-1');
  assert.equal(store.family.invite_code, 'K3M9QP');

  const parents = state.postedCategories.filter((c) => c.parent_id === null);
  const children = state.postedCategories.filter((c) => c.parent_id);
  assert.ok(parents.length >= 14, `默认大类太少：${parents.length}`);
  assert.ok(children.length >= 20, `默认小类太少：${children.length}`);
  assert.equal(state.postedAccounts.length, 4);
  assert.ok(state.postedAccounts.every((a) => a.family_id === 'fam-1'));
  // 两级分类的父 id 必须来自真实插入结果
  assert.ok(children.every((c) => String(c.parent_id).startsWith('parent-')));
});

test('RemoteStore：加入家庭用邀请码，走 RPC 而不是直接写表', async () => {
  const f = makeFetch((rec) => {
    if (rec.path === '/rest/v1/rpc/join_family_by_code') {
      return jsonResponse(200, [{ id: 'fam-9', name: '岳父母家', invite_code: 'QQQ222' }]);
    }
    if (rec.path === '/rest/v1/members') {
      return jsonResponse(200, [{ id: 'user-2', family_id: 'fam-9', display_name: '妈妈', role: 'mother' }]);
    }
    if (rec.path === '/rest/v1/families') {
      return jsonResponse(200, [{ id: 'fam-9', name: '岳父母家', invite_code: 'QQQ222' }]);
    }
    return jsonResponse(200, []);
  });
  globalThis.fetch = f;
  const store = new RemoteStore({ url: URL_BASE, anonKey: KEY, storage: new MemStorage() });
  store.client._writeSession({
    access_token: 't', refresh_token: 'r', expires_at: Date.now() + 1e6, user: { id: 'user-2' },
  });

  const family = await store.joinFamily('qqq222', '妈妈', 'mother');
  const rpcCall = f.calls.find((c) => c.path === '/rest/v1/rpc/join_family_by_code');
  assert.ok(rpcCall, '没有调用 join_family_by_code');
  assert.deepEqual(rpcCall.body, { p_code: 'qqq222', p_display_name: '妈妈', p_role: 'mother' });
  assert.equal(family.id, 'fam-9');
});
