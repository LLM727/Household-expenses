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

test('统计页：按人员和收入构成里的数字必须是钱的样子', async () => {
  // 回归：charts.js 的 normalize() 原来把 display 丢掉，横条图只能显示裸数字。
  // 于是同一屏里「本月支出 ¥xxx」和「按人员 120」两种写法并存，看着不像钱。
  const { app, root } = await boot();
  app.tab = 'stats';
  await app.refreshData();
  app.render();
  const html = root.innerHTML;

  const values = [...html.matchAll(/<span class="hb-value">([^<]*)<\/span>/g)].map((m) => m[1]);
  assert.ok(values.length > 0, '统计页一个横条都没有，这条断言等于没验');
  for (const v of values) {
    assert.match(v, /^[-¥]?¥?[\d,]+\.\d{2}$/, `横条图上的「${v}」不是金额格式（应有 ¥ 和两位小数）`);
  }
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

/* ------------------------------------------------------------------ */
/* 导出：真的生成文件内容，而不是「点了没报错」                          */
/* ------------------------------------------------------------------ */

test('导出 Excel：生成合法的 .xlsx（ZIP 头 + 两个工作表 + 中文）', async () => {
  const { app } = await boot();
  await app.refreshData();
  let captured = null;
  app.download = (blob, filename) => {
    captured = { blob, filename };
  };

  await app.exportXlsx();
  assert.ok(captured, '没有触发下载');
  assert.match(captured.filename, /^家庭记账-\d{4}-\d{2}\.xlsx$/, `文件名不对：${captured.filename}`);

  const bytes = new Uint8Array(await captured.blob.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04], '不是 ZIP 文件头');

  // 存储方式打包，XML 原样可见，直接查内容
  const text = new TextDecoder().decode(bytes);
  assert.ok(text.includes('xl/workbook.xml'), '缺少 workbook 部件');
  assert.ok(text.includes('xl/worksheets/sheet1.xml'), '缺少第一个工作表');
  assert.ok(text.includes('xl/worksheets/sheet2.xml'), '缺少分类汇总表');
  assert.ok(text.includes('分类汇总'), '汇总表名没写进去');
  assert.ok(text.includes('原始输入'), '明细表头没写进去');
});

test('导出 CSV：带 BOM、表头正确、金额是两位小数', async () => {
  const { app } = await boot();
  await app.refreshData();
  let captured = null;
  app.download = (blob, filename) => {
    captured = { blob, filename };
  };

  await app.exportCsv();
  assert.ok(captured, '没有触发下载');
  assert.match(captured.filename, /\.csv$/);

  // Blob.text() 会按规范吃掉 BOM，所以直接看原始字节
  const bytes = new Uint8Array(await captured.blob.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], '没有 BOM，Excel 打开会乱码');

  const text = new TextDecoder().decode(bytes);
  assert.ok(text.includes('"日期","类型","金额"'), '表头不对');
  assert.ok(/"\d+\.\d{2}"/.test(text), '金额不是两位小数');
});

/* ------------------------------------------------------------------ */
/* 语音：浏览器 API 用假替身驱动，验证「说的字 → 草稿卡」这条链路          */
/* ------------------------------------------------------------------ */

function withRawTextInput(root) {
  const box = { value: '' };
  root.querySelector = (selector) => (selector === '#raw-text' ? box : null);
  return box;
}

const results = (transcript, isFinal) => [{ 0: { transcript }, isFinal }];

test('语音：浏览器不支持时说明白，不报错', async () => {
  const { app } = await boot();
  delete globalThis.SpeechRecognition;
  delete globalThis.webkitSpeechRecognition;
  app.startVoice();
  // 具体措辞随设备不同（见下面三条），这里只要求「说清楚不行 + 给出下一步」
  assert.match(app.toastMsg, /不支持|键盘/, `提示不对：${app.toastMsg}`);
});

test('语音：中途结果只填输入框，说完才自动生成草稿', async () => {
  const { app, root } = await boot();
  const box = withRawTextInput(root);
  app.tab = 'record';
  app.render();

  class FakeSR {
    constructor() {
      FakeSR.last = this;
    }

    start() {
      this.onstart?.();
    }
  }
  globalThis.SpeechRecognition = FakeSR;

  app.startVoice();
  assert.equal(app.listenState, 'listening', '没有进入「正在听」状态');
  assert.equal(FakeSR.last.lang, 'zh-CN', `语言不是中文：${FakeSR.last.lang}`);
  assert.equal(FakeSR.last.interimResults, true);

  // 话还没说完：只回填到输入框，不急着解析
  FakeSR.last.onresult({ results: results('今天买菜', false) });
  assert.equal(box.value, '今天买菜', '中途结果没填进输入框');
  assert.equal(app.draft, null, '没说完就生成草稿了');

  // 说完了：自动解析成草稿卡
  FakeSR.last.onresult({ results: results('今天买菜35元', true) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(app.draft, '说完没生成草稿');
  assert.equal(Number(app.draft.amount), 35, `金额没解析出来：${app.draft.amount}`);

  FakeSR.last.onend();
  assert.equal(app.listenState, null, '结束后状态没复位');
  delete globalThis.SpeechRecognition;
});

test('语音：麦克风被拒绝时说人话，并复位状态', async () => {
  const { app } = await boot();
  class FakeSR {
    constructor() {
      FakeSR.last = this;
    }

    start() {
      this.onstart?.();
    }
  }
  globalThis.SpeechRecognition = FakeSR;
  app.startVoice();
  FakeSR.last.onerror({ error: 'not-allowed' });

  assert.match(app.toastMsg, /麦克风被拒绝/, `提示不对：${app.toastMsg}`);
  assert.equal(app.listenState, null, '出错后状态没复位');
  delete globalThis.SpeechRecognition;
});

/* ---------- 语音输入的设备差异：给出的建议必须能照做 ---------- */

const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const UA_CHROME_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 在「假装是某台设备」的环境里跑一段：换掉 userAgent 和语音能力，跑完一定还原 */
async function withDevice({ ua, speech }, fn) {
  const navDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const hadSR = 'SpeechRecognition' in globalThis;
  const hadWebkit = 'webkitSpeechRecognition' in globalThis;
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: ua, maxTouchPoints: 0 },
    configurable: true,
    writable: true,
  });
  if (speech) globalThis.SpeechRecognition = function FakeSR() {};
  else {
    delete globalThis.SpeechRecognition;
    delete globalThis.webkitSpeechRecognition;
  }
  try {
    return await fn();
  } finally {
    if (navDesc) Object.defineProperty(globalThis, 'navigator', navDesc);
    else delete globalThis.navigator;
    if (!hadSR) delete globalThis.SpeechRecognition;
    if (!hadWebkit) delete globalThis.webkitSpeechRecognition;
  }
}

test('iPhone 上没语音能力：指点用键盘听写，而不是让人「换个浏览器」', async () => {
  await withDevice({ ua: UA_IPHONE, speech: false }, async () => {
    const { app, root } = await boot();
    app.tab = 'record';
    app.render();
    const html = root.innerHTML;
    assert.match(html, /键盘/, 'iPhone 上应该告诉用户用键盘听写');
    assert.match(html, /🎤/, '要指出键盘上那个麦克风键');
    assert.doesNotMatch(html, /换 Chrome \/ Edge/, 'iPhone 上让用户换浏览器，照做也没用（内核都是 WebKit）');

    app.startVoice();
    assert.match(app.toastMsg, /键盘/, `点麦克风后的提示不对：${app.toastMsg}`);
  });
});

test('桌面上没有语音能力：建议换 Chrome / Edge 或打字', async () => {
  await withDevice({ ua: UA_CHROME_DESKTOP, speech: false }, async () => {
    const { app, root } = await boot();
    app.tab = 'record';
    app.render();
    assert.match(root.innerHTML, /Chrome \/ Edge/);
  });
});

test('浏览器自带语音能力时，不显示多余的说明', async () => {
  await withDevice({ ua: UA_IPHONE, speech: true }, async () => {
    const { app, root } = await boot();
    app.tab = 'record';
    app.render();
    const html = root.innerHTML;
    assert.doesNotMatch(html, /网页用不了浏览器语音/, '能用就别啰嗦');
    assert.match(html, /🎤/); // 麦克风按钮本身还在
  });
});
