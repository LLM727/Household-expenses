/**
 * 界面冒烟测试：用最小 DOM 替身跑一遍渲染，确认四个标签页都能出内容。
 * 不追求像素级验证，只保证「没有 JS 报错、关键区块都在」。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

class FakeEl {
  constructor(tag = 'div') {
    this.tag = tag;
    this._html = '';
    this.dataset = {};
    this.value = '';
    this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
  }

  get innerHTML() {
    return this._html;
  }

  set innerHTML(v) {
    this._html = String(v);
  }

  addEventListener() {}

  removeEventListener() {}

  querySelector() {
    return null;
  }

  querySelectorAll() {
    return [];
  }

  remove() {}

  closest() {
    return null;
  }
}

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

// 给 store.js 的默认参数准备一个 localStorage
globalThis.localStorage = new MemStorage();

const { App } = await import('../src/app.js');
const { DemoStore } = await import('../src/store.js');

async function boot() {
  const root = new FakeEl();
  const store = new DemoStore(new MemStorage());
  const app = new App(root, store);
  await app.init();
  return { app, root };
}

test('首屏：演示模式下直接进入记账页', async () => {
  const { root } = await boot();
  const html = root.innerHTML;
  assert.match(html, /演示家庭/);
  assert.match(html, /本月支出/);
  assert.match(html, /记一笔/);
  assert.match(html, /演示模式/);
  for (const name of ['记账', '流水', '统计', '我的']) {
    assert.ok(html.includes(name), `底部导航缺少 ${name}`);
  }
});

test('语音/文字输入 → 识别草稿卡片', async () => {
  const { app, root } = await boot();
  await app.doParse('今天买菜35元');
  const html = root.innerHTML;
  assert.match(html, /识别结果/);
  assert.match(html, /value="35"/);
  assert.match(html, /date/);
});

test('流水页：能列出种子账目', async () => {
  const { app, root } = await boot();
  app.tab = 'list';
  await app.refreshData();
  app.render();
  const html = root.innerHTML;
  assert.match(html, /导出这个月的 Excel/);
  assert.ok((html.match(/class="tx"/g) || []).length >= 5, '流水条目太少');
});

test('统计页：图表与环比都在', async () => {
  const { app, root } = await boot();
  app.tab = 'stats';
  await app.refreshData();
  app.render();
  const html = root.innerHTML;
  assert.match(html, /支出构成/);
  assert.match(html, /近 6 个月趋势/);
  assert.match(html, /按人员/);
  assert.match(html, /<svg class="donut"/);
  assert.match(html, /<svg class="bars"/);
  assert.match(html, /分类趋势/);
  assert.match(html, /trend-table/);
  assert.match(html, /预算/);
});

test('我的页：邀请码、成员、分类管理', async () => {
  const { app, root } = await boot();
  app.tab = 'me';
  app.render();
  const html = root.innerHTML;
  assert.match(html, /DEMO01/);
  assert.match(html, /爸爸/);
  assert.match(html, /分类管理/);
  assert.match(html, /退出演示/);
});

test('编辑账目：点开一条进入编辑态', async () => {
  const { app, root } = await boot();
  const anyTx = [...app.cache.values()][0];
  await app._handleAction('edit-tx', { dataset: { id: anyTx.id } }, {});
  assert.equal(app.tab, 'record');
  assert.ok(app.draft);
  assert.match(root.innerHTML, /修改这笔账/);
});

test('保存一笔账：写入后缓存与页面都更新', async () => {
  const { app, root } = await boot();
  await app.doParse('昨天打车花了66元');
  const before = [...app.cache.values()].length;
  await app.saveDraft();
  const after = [...app.cache.values()].length;
  assert.equal(after, before + 1);
  assert.equal(app.draft, null);
  assert.match(root.innerHTML, /本月支出/);
});

test('转账草稿：出现转出/转入账户选择', async () => {
  const { app, root } = await boot();
  await app.doParse('从银行卡转账500到微信');
  const html = root.innerHTML;
  assert.match(html, /转出账户/);
  assert.match(html, /转入账户/);
  assert.match(html, /银行卡/);
  assert.match(html, /微信/);
  assert.equal(app.draft.kind, 'transfer');
  assert.ok(app.draft.toAccountId, '没认出转入账户');
});

test('我的页：账户余额按账目推算', async () => {
  const { app, root } = await boot();
  app.tab = 'me';
  await app.ensureFullHistory();
  app.render();
  const html = root.innerHTML;
  assert.match(html, /账户余额/);
  assert.match(html, /现金/);
});

test('报销闭环：垫付 → 报销回款冲减同一笔支出', async () => {
  const { app, root } = await boot();

  // 1) 记一笔垫付
  await app.doParse('先垫付打车费60元');
  assert.equal(app.draft.reimbursable, true);
  await app.saveDraft();

  const paid = [...app.cache.values()].filter((t) => t.reimbursable);
  assert.equal(paid.length, 1, '垫付没有被标记');
  const paidTx = paid[0];
  assert.ok(paidTx.category_id, '垫付应该有分类');

  // 2) 记报销回款，并关联到那笔垫付
  await app.doParse('报销回来60元');
  assert.equal(app.draft.kind, 'reimburse_back');
  assert.match(root.innerHTML, /冲减哪笔垫付/);

  app._onRootChange({ target: { dataset: { bind: 'draft', field: 'reimburseOf' }, value: paidTx.id } });
  assert.equal(app.draft.categoryId, paidTx.category_id, '没有自动带上原分类');

  await app.saveDraft();
  const back = [...app.cache.values()].find((t) => t.kind === 'reimburse_back');
  assert.ok(back, '报销回款没写进去');
  assert.equal(back.reimburse_of, paidTx.id);
  assert.equal(back.category_id, paidTx.category_id);

  // 3) 两者相抵，该分类净支出回到 0
  const { byCategory } = await import('../src/analytics.js');
  const rows = byCategory([paidTx, back], app.categories, 'expense');
  const hit = rows.find((r) => r.categoryId === paidTx.category_id);
  assert.ok(!hit || hit.total === 0, `报销后分类仍有支出：${hit && hit.total}`);
});

test('转账校验：转出与转入不能相同', async () => {
  const { app } = await boot();
  await app.doParse('从银行卡转账500到微信');
  const acc = app.store.accounts;
  app.draft.accountId = acc[0].id;
  app.draft.toAccountId = acc[0].id;
  const before = [...app.cache.values()].length;
  await app.saveDraft();
  assert.equal([...app.cache.values()].length, before, '同账户转账不该被保存');
  assert.ok(app.draft, '校验失败时草稿应保留');
});

/* ------------------------------------------------------------------ */
/* 标签配对检查：界面是手写模板字符串拼的，少一个 </div> 不会报错，       */
/* 但会让页面结构错乱（长辈手机上尤其明显），所以逐页检查一下。          */
/* ------------------------------------------------------------------ */

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

function assertBalancedHtml(html, label) {
  const stack = [];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const selfClosed = /\/\s*$/.test(m[3]);
    if (VOID_TAGS.has(tag) || selfClosed) continue;
    if (closing) {
      const top = stack.pop();
      assert.equal(top, tag, `${label}: </${tag}> 对不上，栈顶是 <${top}>`);
    } else {
      stack.push(tag);
    }
  }
  assert.deepEqual(stack, [], `${label}: 有标签没闭合 → ${stack.join(' > ')}`);
}

test('每个 data-act 都有对应的处理分支', async () => {
  const { app, root } = await boot();
  const seen = new Set();
  const collect = () => {
    for (const m of root.innerHTML.matchAll(/data-act="([^"]+)"/g)) seen.add(m[1]);
  };

  for (const tab of ['record', 'list', 'stats', 'me']) {
    app.tab = tab;
    if (tab === 'list' || tab === 'stats') await app.refreshData();
    if (tab === 'me') await app.ensureFullHistory();
    app.render();
    collect();
  }
  app.showCategoryManager = true; // 分类管理展开后还有一批按钮
  app.tab = 'me';
  app.render();
  collect();
  await app.doParse('今天买菜35元');
  collect();
  await app.doParse('从银行卡转账500到微信');
  collect();
  app.draft = null;
  const db = app.store.db;
  db.session = null;
  app.render();
  collect();
  db.session = { user: { id: 'u-demo' } };
  db.profile = { ...db.profile, family_id: null };
  app.render();
  collect();

  const source = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  const handled = new Set([...source.matchAll(/case\s+'([^']+)'/g)].map((m) => m[1]));

  assert.ok(seen.size > 10, `只找到 ${seen.size} 个 data-act，样本太少`);
  const missing = [...seen].filter((a) => !handled.has(a));
  assert.deepEqual(missing, [], `这些按钮点了没反应（没有 case 分支）：${missing.join(', ')}`);
});

test('每个 data-field 都会被读进草稿', async () => {
  const { app, root } = await boot();
  const fields = new Set();
  for (const raw of ['今天买菜35元', '从银行卡转账500到微信', '报销回来60元']) {
    app.draft = null;
    await app.doParse(raw);
    for (const m of root.innerHTML.matchAll(/data-field="([^"]+)"/g)) fields.add(m[1]);
  }

  assert.ok(fields.size >= 4, `只找到 ${fields.size} 个可编辑字段`);
  const source = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  const missing = [...fields].filter((f) => !source.includes(`field === '${f}'`));
  assert.deepEqual(missing, [], `这些字段改了不会生效：${missing.join(', ')}`);
});

test('每个页面的 HTML 标签都配对', async () => {
  const { app, root } = await boot();

  for (const tab of ['record', 'list', 'stats', 'me']) {
    app.tab = tab;
    if (tab === 'list' || tab === 'stats') await app.refreshData();
    if (tab === 'me') await app.ensureFullHistory();
    app.render();
    assertBalancedHtml(root.innerHTML, `${tab} 页`);
  }

  // 草稿卡（普通收入、转账两套分支）
  await app.doParse('今天买菜35元');
  assertBalancedHtml(root.innerHTML, '普通草稿');
  app.draft = null;
  await app.doParse('从银行卡转账500到微信');
  assertBalancedHtml(root.innerHTML, '转账草稿');

  // 报销回款草稿
  app.draft = null;
  await app.doParse('报销回来60元');
  assertBalancedHtml(root.innerHTML, '报销草稿');

  // 未登录 / 未入家庭 两个前置页（演示模式下状态存在 store.db 里）
  app.draft = null;
  const db = app.store.db;
  const savedSession = db.session;
  const savedProfile = db.profile;
  db.session = null;
  app.render();
  assertBalancedHtml(root.innerHTML, '登录页');
  db.session = savedSession;
  db.profile = { ...savedProfile, family_id: null };
  app.render();
  assertBalancedHtml(root.innerHTML, '建家页');
  db.profile = savedProfile;
});
