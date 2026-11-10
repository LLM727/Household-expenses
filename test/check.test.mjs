/** 自检脚本的判断逻辑（不发网络请求，只测状态 → 结论的翻译） */

import test from 'node:test';
import assert from 'node:assert/strict';
import { judge } from '../tools/check-config.js';

const okSettings = { status: 200, json: { mailer_autoconfirm: true, disable_signup: false } };
const emptyTables = { status: 200, json: [], text: '[]' };
const okRpc = { status: 401, text: '{"message":"..."}' };

function levels(results) {
  return results.map((r) => r.level);
}

test('全部正常：没有失败项', () => {
  const r = judge({ settings: okSettings, tables: emptyTables, rpc: okRpc });
  assert.equal(r.filter((x) => x.level === 'fail').length, 0);
  assert.equal(r.filter((x) => x.level === 'warn').length, 0);
});

test('危险：匿名能读到数据 = 行级权限没开', () => {
  const r = judge({
    settings: okSettings,
    tables: { status: 200, json: [{ id: 'fam-1' }], text: '[{"id":"fam-1"}]' },
    rpc: okRpc,
  });
  const bad = r.find((x) => x.level === 'fail');
  assert.ok(bad, '没报警');
  assert.match(bad.title, /行级权限/);
});

test('表不存在 → 提示去跑 schema.sql', () => {
  const r = judge({
    settings: okSettings,
    tables: { status: 404, text: '{"message":"relation does not exist"}' },
    rpc: okRpc,
  });
  const bad = r.find((x) => x.level === 'fail');
  assert.match(bad.title, /表不存在/);
  assert.match(bad.detail, /schema\.sql/);
});

test('函数缺失 → 也能识别出来', () => {
  const r = judge({
    settings: okSettings,
    tables: emptyTables,
    rpc: { status: 404, text: '{"code":"PGRST202"}' },
  });
  assert.match(r.find((x) => x.level === 'fail').title, /函数缺失/);
});

test('anon key 错误', () => {
  const r = judge({
    settings: { status: 401, json: { message: 'Invalid API key' } },
    tables: { status: 401, text: 'Invalid API key' },
    rpc: { status: 401, text: '' },
  });
  assert.match(r.find((x) => x.level === 'fail').title, /anon key/);
});

test('邮箱确认还开着 → 只提醒不拦', () => {
  const r = judge({
    settings: { status: 200, json: { mailer_autoconfirm: false, disable_signup: false } },
    tables: emptyTables,
    rpc: okRpc,
  });
  assert.equal(r.filter((x) => x.level === 'fail').length, 0);
  assert.match(r.find((x) => x.level === 'warn').title, /邮箱确认/);
});

test('注册被关掉 → 失败项', () => {
  const r = judge({
    settings: { status: 200, json: { disable_signup: true } },
    tables: emptyTables,
    rpc: okRpc,
  });
  assert.match(r.find((x) => x.level === 'fail').title, /注册/);
});

test('网络不通：只给一条明确结论', () => {
  const r = judge({ networkError: 'fetch failed' });
  assert.equal(r.length, 1);
  assert.equal(r[0].level, 'fail');
  assert.match(r[0].title, /连不上/);
});

test('levels 顺序稳定：先地址、再表、再函数', () => {
  const r = judge({ settings: okSettings, tables: emptyTables, rpc: okRpc });
  assert.equal(levels(r).length >= 3, true);
  assert.match(r[0].title, /项目地址/);
  assert.match(r[1].title, /数据表/);
});
