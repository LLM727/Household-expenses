/**
 * 界面冒烟测试：用最小 DOM 替身跑一遍渲染，确认四个标签页都能出内容。
 * 不追求像素级验证，只保证「没有 JS 报错、关键区块都在」。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

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
