/**
 * 翻页测试：Supabase（PostgREST）单次响应最多 1000 行，超出部分**静默截断**。
 *
 * 这个限制不会报错，只会少给数据。后果很隐蔽：
 *   - 账户余额按「全部历史」算，超过 1000 笔后余额会算错；
 *   - 长期使用后，统计和导出的数字会悄悄变少，而且没人知道为什么。
 *
 * 所以这里一次塞 1205 条（全部同一天，排序键大量相同，顺带压测翻页的稳定性），
 * 断言「一条不少、一条不重」。
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

const TOTAL = 1205;

let fake;
let store;

before(async () => {
  fake = await startFakeSupabase();
  store = new RemoteStore({ url: fake.url, anonKey: fake.anonKey, storage: new MemStorage() });
  await store.signUp('big@test.com', 'pw123456', '爸爸');
  await store.createFamily('大家庭', '爸爸', 'father');

  const rows = Array.from({ length: TOTAL }, (_, i) => ({
    family_id: store.family.id,
    created_by: store.client.userId,
    kind: 'expense',
    amount: (i % 100) + 1,
    occurred_on: '2026-11-01', // 故意全同一天：排序键大量相同
    note: `第${i + 1}笔`,
  }));
  for (let i = 0; i < rows.length; i += 300) {
    await store.client.table('transactions', {
      method: 'POST',
      body: rows.slice(i, i + 300),
      prefer: 'return=representation',
    });
  }
});

after(async () => {
  await fake?.close();
});

test('一次拉全部：1205 条一条不少（不会停在 1000 条）', async () => {
  const rows = await store.fetchTransactions('2000-01-01', '2100-12-31');
  assert.equal(rows.length, TOTAL, `只取回 ${rows.length} 条，被 PostgREST 静默截断了`);
});

test('翻页不重不漏：id 全不重复，金额合计对得上', async () => {
  const rows = await store.fetchTransactions('2000-01-01', '2100-12-31');
  const ids = new Set(rows.map((r) => r.id));
  assert.equal(ids.size, rows.length, `翻页出现重复行：${rows.length} 行里只有 ${ids.size} 个不同 id`);

  const expected = Array.from({ length: TOTAL }, (_, i) => (i % 100) + 1).reduce((a, b) => a + b, 0);
  const actual = rows.reduce((sum, r) => sum + Number(r.amount), 0);
  assert.equal(actual, expected, `金额合计不对（有漏行）：${actual} ≠ ${expected}`);
});

test('窄区间仍然正常：只取当月不受影响', async () => {
  const rows = await store.fetchTransactions('2026-11-01', '2026-11-30');
  assert.equal(rows.length, TOTAL);
  const none = await store.fetchTransactions('2026-12-01', '2026-12-31');
  assert.equal(none.length, 0);
});
