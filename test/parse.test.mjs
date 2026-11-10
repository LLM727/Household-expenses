import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEntry, cnToNumber, extractAmount, extractDate } from '../src/parse.js';
import { DEFAULT_CATEGORIES } from '../src/defaults.js';

/** 把 defaults 里的树拍平成数据库里的行结构，模拟线上数据结构 */
function flattenCategories() {
  const rows = [];
  for (const parent of DEFAULT_CATEGORIES) {
    rows.push({
      id: parent.key,
      name: parent.name,
      kind: parent.kind,
      parent_id: null,
      fullName: parent.name,
      keywords: parent.keywords || [],
    });
    for (const child of parent.children || []) {
      rows.push({
        id: child.key,
        name: child.name,
        kind: parent.kind,
        parent_id: parent.key,
        fullName: `${parent.name}/${child.name}`,
        keywords: child.keywords || [],
      });
    }
  }
  return rows;
}

const ctx = {
  today: '2026-11-11',
  members: [
    { id: 'm-dad', display_name: '爸爸', role: 'father' },
    { id: 'm-mom', display_name: '妈妈', role: 'mother' },
    { id: 'm-kid', display_name: '小明', role: 'child' },
  ],
  categories: flattenCategories(),
};

test('中文数字转换', () => {
  assert.equal(cnToNumber('三十'), 30);
  assert.equal(cnToNumber('一百五'), 150);
  assert.equal(cnToNumber('三千'), 3000);
  assert.equal(cnToNumber('一万二'), 12000);
});

test('金额提取：带单位优先，跳过日期数字', () => {
  assert.equal(extractAmount('花了35.5元').value, 35.5);
  assert.equal(extractAmount('1.5万').value, 15000);
  assert.equal(extractAmount('3000块').value, 3000);
  assert.equal(extractAmount('没有数字'), null);
});

test('日期提取：相对日期与月日', () => {
  assert.equal(extractDate('今天买菜', '2026-11-11').date, '2026-11-11');
  assert.equal(extractDate('昨天买菜', '2026-11-11').date, '2026-11-10');
  assert.equal(extractDate('11月8日买菜', '2026-11-11').date, '2026-11-08');
  assert.equal(extractDate('2026年3月2日买菜', '2026-11-11').date, '2026-03-02');
  // 跨年补录：今天 11 月，说 12 月的账，应归到去年
  assert.equal(extractDate('12月20日买菜', '2026-11-11').date, '2025-12-20');
});

test('场景1：11月8日购买牛奶花了35.5元', () => {
  const r = parseEntry('11月8日购买牛奶花了35.5元', ctx);
  assert.equal(r.amount, 35.5);
  assert.equal(r.occurredOn, '2026-11-08');
  assert.equal(r.kind, 'expense');
  assert.ok(['shopping', 'shopping-daily'].includes(r.categoryId), `实际归类：${r.categoryId}`);
  assert.match(r.note, /牛奶/);
});

test('场景2：今天给孩子报了补习班花了3000', () => {
  const r = parseEntry('今天给孩子报了补习班花了3000', ctx);
  assert.equal(r.amount, 3000);
  assert.equal(r.occurredOn, '2026-11-11');
  assert.equal(r.categoryId, 'education-training');
  assert.equal(r.memberId, 'm-kid');
});

test('场景3：收到工资8000元 → 收入', () => {
  const r = parseEntry('收到工资8000元', ctx);
  assert.equal(r.kind, 'income');
  assert.equal(r.amount, 8000);
  assert.equal(r.categoryId, 'salary');
});

test('场景4：发奖金2000 → 收入/奖金', () => {
  const r = parseEntry('发奖金2000', ctx);
  assert.equal(r.kind, 'income');
  assert.equal(r.amount, 2000);
  assert.equal(r.categoryId, 'bonus');
});

test('场景5：转账不计入收支', () => {
  const r = parseEntry('从银行卡转账500到微信', ctx);
  assert.equal(r.kind, 'transfer');
  assert.equal(r.amount, 500);
  assert.equal(r.categoryId, null);
});

test('场景6：借给别人钱不计入支出', () => {
  const r = parseEntry('借给老王1000元', ctx);
  assert.equal(r.kind, 'lend');
  assert.equal(r.amount, 1000);
});

test('场景7：报销回款不计入收入', () => {
  const r = parseEntry('报销回来200元', ctx);
  assert.equal(r.kind, 'reimburse_back');
  assert.equal(r.amount, 200);
});

test('场景8：垫付要标记可报销', () => {
  const r = parseEntry('先垫付打车费60元', ctx);
  assert.equal(r.kind, 'expense');
  assert.equal(r.reimbursable, true);
  assert.equal(r.categoryId, 'traffic-taxi');
});

test('场景9：中文数字金额', () => {
  const r = parseEntry('昨天买菜三十五块', ctx);
  assert.equal(r.amount, 35);
  assert.equal(r.occurredOn, '2026-11-10');
  assert.equal(r.categoryId, 'food-market');
});

test('场景10：房贷/电费归到居住', () => {
  assert.equal(parseEntry('交电费180元', ctx).categoryId, 'housing-utility');
  assert.equal(parseEntry('还房贷5000', ctx).categoryId, 'housing-rent');
});

test('场景11：会员按人识别——爸爸的工资', () => {
  const r = parseEntry('爸爸收到工资12000元', ctx);
  assert.equal(r.memberId, 'm-dad');
  assert.equal(r.kind, 'income');
  assert.equal(r.amount, 12000);
});

test('场景12：无金额时应给出提示而不是崩溃', () => {
  const r = parseEntry('今天心情不错', ctx);
  assert.equal(r.amount, null);
  assert.equal(r.ok, false);
  assert.ok(r.warnings.length > 0);
});

test('场景13：空输入不崩溃', () => {
  const r = parseEntry('   ', ctx);
  assert.equal(r.ok, false);
  assert.equal(r.amount, null);
});
