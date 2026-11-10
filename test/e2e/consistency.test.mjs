/**
 * 跨界面一致性：同一个月的「支出/收入合计」，不管从哪个入口看，必须是同一个数。
 *
 * 用户会同时看四个地方：流水页顶部的合计、统计页的大字、导出的 CSV、导出的 Excel。
 * 只要其中两个对不上，整本账的可信度就没了——而这种不一致在手工抽查里几乎发现不了，
 * 因为它需要「把四个来源的数字抄下来对比」。
 *
 * 这里造一个混合了 9 种收支类型的月份（含下个月的干扰账目），然后四处逐一核对。
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeSupabase } from './fake-supabase.mjs';
import { MiniEl } from './mini-dom.mjs';
import { App } from '../../src/app.js';
import { RemoteStore } from '../../src/store.js';
import * as A from '../../src/analytics.js';
import { money } from '../../src/utils.js';

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
before(async () => {
  fake = await startFakeSupabase();
});
after(async () => {
  await fake?.close();
});

async function bootFamily(email) {
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

/** 本月的账，混合 9 种类型；外加一笔下个月的干扰账目 */
async function seedMonth(app, store) {
  const month = app.month;
  const prevMonth = (() => {
    const [y, m] = month.split('-').map(Number);
    const d = new Date(y, m - 2, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  })();
  const cat = (name) => store.categories.find((c) => c.name === name);
  const acc = (name) => store.accounts.find((a) => a.name === name);
  const me = store.members[0].id;
  const base = (day) => `${month}-${String(day).padStart(2, '0')}`;

  const rows = [
    { kind: 'expense', amount: 35.5, category_id: cat('买菜').id, occurred_on: base(3), member_id: me, note: '买菜' },
    { kind: 'expense', amount: 200, category_id: cat('水电燃气').id, occurred_on: base(5), member_id: me, note: '水费' },
    // 垫付：算支出，但标记可报销
    { kind: 'expense', amount: 100, category_id: cat('打车').id, occurred_on: base(7), member_id: me, reimbursable: true },
    { kind: 'income', amount: 12000, category_id: cat('工资薪金').id, occurred_on: base(10), member_id: me },
    // 下面这些都不该进收支合计
    { kind: 'transfer', amount: 1000, occurred_on: base(11), account_id: acc('银行卡').id, to_account_id: acc('现金').id },
    { kind: 'lend', amount: 500, occurred_on: base(12), category_id: null },
    { kind: 'lend_return', amount: 500, occurred_on: base(13), category_id: null },
    { kind: 'borrow', amount: 300, occurred_on: base(14), category_id: null },
    { kind: 'borrow_return', amount: 300, occurred_on: base(15), category_id: null },
    // 报销回款：不算收入，冲减支出
    { kind: 'reimburse_back', amount: 100, occurred_on: base(16), category_id: null },
    // 下个月的干扰账目：不能混进本月
    { kind: 'expense', amount: 9999, category_id: cat('买菜').id, occurred_on: `${prevMonth}-20`, member_id: me },
  ];
  for (const r of rows) {
    await store.addTransaction({
      note: '',
      raw_input: '',
      reimbursable: false,
      member_id: null,
      account_id: null,
      to_account_id: null,
      reimburse_of: null,
      category_id: null,
      ...r,
    });
  }
  await app.refreshData();
  return { month, prevMonth };
}

/** 一个月的最后一天（11 月只有 30 天，不能一律写 -31） */
function monthEnd(month) {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return `${month}-${String(last).padStart(2, '0')}`;
}

/** 从一个月的账目推出「应该看到」的数字（口径由 analytics 定义） */
async function expectedTotals(store, month) {
  const all = await store.fetchTransactions(`${month}-01`, monthEnd(month));
  const rows = all.filter((t) => String(t.occurred_on).slice(0, 7) === month);
  return { rows, totals: A.totals(rows) };
}

/** 把导出的 CSV 抓下来（不碰 URL.createObjectURL，直接接管 download） */
function captureDownload(app) {
  const files = [];
  app.download = (blob, filename) => {
    files.push({ blob, filename });
    return undefined;
  };
  return files;
}

function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  const cells = (line) => {
    const out = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"') {
        if (quoted && line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else quoted = !quoted;
      } else if (ch === ',' && !quoted) {
        out.push(cur);
        cur = '';
      } else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const rows = lines.map(cells);
  const header = rows.shift();
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

test('同一个月的支出/收入：页面、CSV、Excel 三处必须一致', async () => {
  const { app, root, store } = await bootFamily('consistency@test.com');
  const { month } = await seedMonth(app, store);
  const { rows, totals } = await expectedTotals(store, month);

  // 口径自检：支出 = 35.5 + 200 + 100 - 100（报销回款冲减）= 235.5；收入 = 12000
  assert.equal(rows.length, 10, `本月应有 10 条，实际 ${rows.length}`);
  assert.equal(totals.expense, 235.5, `支出合计不对：${totals.expense}`);
  assert.equal(totals.income, 12000, `收入合计不对：${totals.income}`);
  assert.equal(totals.special.transfer, 1000);
  assert.equal(totals.special.lend, 500);

  // ① 流水页
  app.tab = 'list';
  app.month = month;
  app.render();
  assert.ok(root.has(money(235.5)), '流水页没有显示支出合计 ¥235.50');
  assert.ok(root.has(money(12000)), '流水页没有显示收入合计 ¥12,000.00');

  // ② 统计页
  app.tab = 'stats';
  app.render();
  const statsHtml = root.innerHTML;
  assert.ok(statsHtml.includes(money(235.5)), '统计页的支出合计和流水页不一致');
  assert.ok(statsHtml.includes(money(12000)), '统计页的收入合计和流水页不一致');

  // ③ CSV
  const files = captureDownload(app);
  app.exportCsv();
  assert.equal(files.length, 1, '没有触发 CSV 下载');
  const csv = parseCsv(await files[0].blob.text());
  assert.equal(csv.length, 10, `CSV 应有 10 行明细，实际 ${csv.length}`);
  const csvExpense = csv.reduce((acc, r) => {
    const amount = Number(r['金额']);
    if (r['类型'] === '支出') return acc + amount;
    if (r['类型'] === '报销回款') return acc - amount;
    return acc;
  }, 0);
  const csvIncome = csv.filter((r) => r['类型'] === '收入').reduce((acc, r) => acc + Number(r['金额']), 0);
  assert.equal(Math.round(csvExpense * 100) / 100, totals.expense, 'CSV 加出来的支出和页面不一致');
  assert.equal(Math.round(csvIncome * 100) / 100, totals.income, 'CSV 加出来的收入和页面不一致');

  // ④ Excel（xlsx 是「存储模式」压缩，单元格内容原样躺在字节里，可以直接找）
  app.exportXlsx();
  assert.equal(files.length, 2, '没有触发 Excel 下载');
  const bytes = new Uint8Array(await files[1].blob.arrayBuffer());
  const text = new TextDecoder('utf-8').decode(bytes);
  assert.ok(text.includes('合计'), 'Excel 里没有「合计」行');
  assert.ok(text.includes('235.5'), 'Excel 里的支出合计和页面不一致');
  assert.ok(text.includes('12000'), 'Excel 里的收入合计和页面不一致');
  assert.ok(!text.includes('9999'), 'Excel 把别的月份的账也导出来了');
});

test('特殊类型：明细里看得到，但不进合计', async () => {
  const { app, store } = await bootFamily('kinds@test.com');
  const { month } = await seedMonth(app, store);
  const files = captureDownload(app);
  app.exportCsv();
  const csv = parseCsv(await files[0].blob.text());

  const kinds = new Set(csv.map((r) => r['类型']));
  for (const name of ['转账', '借出', '收回借款', '借入', '归还借款', '报销回款']) {
    assert.ok(kinds.has(name), `CSV 里少了「${name}」这类账目`);
  }
  // 明细加起来有 1.5 万多，合计却只有 235.5——说明特殊类型确实被排除了
  const naiveSum = csv.reduce((acc, r) => acc + Number(r['金额']), 0);
  assert.ok(naiveSum > 10000, `明细金额之和应远大于合计，实际 ${naiveSum}`);
  const { totals } = await expectedTotals(store, month);
  assert.ok(totals.expense < naiveSum, '合计不该等于明细原始相加');
});

test('上个月的账不会混进这个月的合计和导出', async () => {
  const { app, root, store } = await bootFamily('months@test.com');
  const { month } = await seedMonth(app, store);
  const { totals } = await expectedTotals(store, month);
  assert.ok(totals.expense < 9999, '上个月那笔 9999 混进了本月合计');

  app.tab = 'list';
  app.month = month;
  app.render();
  assert.ok(!root.has('9,999'), '流水页出现了别的月份的账目');

  const files = captureDownload(app);
  app.exportCsv();
  const csvText = await files[0].blob.text();
  assert.ok(!csvText.includes('9999'), 'CSV 里出现了别的月份的账目');
});

test('报销回款冲减支出后，饼图不能绕圈、百分比不能超过 100%', async () => {
  const { app, root } = await bootFamily('pie@test.com');
  // 走真实路径记账：报销回款会被归到「其他支出」这个分类上（负数）
  for (const s of ['今天买菜35.5元', '交电费200', '公司报销回来100']) {
    await app.doParse(s);
    await app.saveDraft();
  }
  await app.refreshData();
  app.tab = 'stats';
  app.render();

  const html = root.innerHTML;
  const pieSection = html.slice(html.indexOf('支出构成'), html.indexOf('近 6 个月趋势'));
  assert.ok(pieSection.includes('报销回款冲减了支出'), '饼图少画了钱，却没有告诉用户为什么');

  const pcts = [...pieSection.matchAll(/(\d+)%/g)].map((m) => Number(m[1]));
  assert.ok(pcts.length > 0, '饼图区没有任何百分比');
  assert.ok(pcts.every((p) => p >= 0 && p <= 100), `出现了不可能的百分比：${pcts.join('%,')}%`);

  const circumference = 2 * Math.PI * (50 - 26 / 2);
  const lens = [...pieSection.matchAll(/stroke-dasharray="([\d.]+) /g)].map((m) => Number(m[1]));
  const drawn = lens.reduce((a, b) => a + b, 0);
  assert.ok(lens.length >= 2, `应该画出 2 个扇形，实际 ${lens.length} 个`);
  assert.ok(
    drawn <= circumference + 0.5,
    `扇形总弧长 ${drawn.toFixed(1)} 超过整圈 ${circumference.toFixed(1)}，饼图会重叠绕圈`,
  );
});

test('预算超支：设了预算且超了，统计页要明确说出来', async () => {
  const { app, root, store } = await bootFamily('budget@test.com');
  const { month } = await seedMonth(app, store);
  const groceries = store.categories.find((c) => c.name === '买菜');
  // 买菜花了 35.5，预算给 30
  await store.saveBudget(month, groceries.id, 30);
  await app.refreshData();
  app.month = month;
  app.tab = 'stats';
  app.render();
  assert.ok(root.has('已超支'), '超支了却没在统计页上提示');
  assert.ok(root.has('买菜'), '提示里没说是哪个分类超了');
});
