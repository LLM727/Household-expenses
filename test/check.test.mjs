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

test('空表不能宣称「行级权限生效」——那两种情况读接口分不开', () => {
  // RLS 打开时会过滤成空数组；可一张新建的空表在 RLS 关闭时同样返回空数组。
  // 光靠匿名读分不开，写探针又违反「只读」的承诺，所以措辞必须留有余地，
  // 并把确定性交给 pg_tables 那句 SQL。
  const r = judge({ settings: okSettings, tables: emptyTables, rpc: okRpc });
  const tableLine = r.find((x) => /数据表/.test(x.title));
  assert.ok(tableLine, '没给出表的结论');

  assert.ok(
    !/行级权限生效/.test(tableLine.title),
    `空表就宣称权限生效了，这是误报：「${tableLine.title}」`,
  );
  assert.match(tableLine.title, /读不到/, `标题没说清观察到什么：「${tableLine.title}」`);

  // 必须告诉用户怎么 100% 确认，否则这句提醒等于白说
  assert.match(tableLine.detail, /pg_tables/, '没给出确认办法（应有 pg_tables 那句 SQL）');
  assert.match(tableLine.detail, /rowsecurity/, '确认办法里没提到要看 rowsecurity');
  assert.match(tableLine.detail, /6 行/, '没说明应该看到 6 行');
});

test('真读到数据时，必须明确说「没生效、先别上线」', () => {
  // 这是方向相反的那一半：误报（空表说生效）已经钉住了，
  // 漏报（有数据却说没问题）更致命，这里单独钉一次。
  const r = judge({
    settings: okSettings,
    tables: { status: 200, json: [{ id: 'a' }, { id: 'b' }], text: '[]' },
    rpc: okRpc,
  });
  const bad = r.find((x) => x.level === 'fail');
  assert.ok(bad, '匿名读到 2 行数据却没报失败');
  assert.match(bad.title, /没生效|别上线/, `失败项标题不够重：「${bad.title}」`);
  assert.match(bad.detail, /2 行/, '没说读到几行');
  assert.match(bad.detail, /schema\.sql/, '没告诉用户怎么办');
});

