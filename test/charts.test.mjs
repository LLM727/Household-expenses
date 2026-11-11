/**
 * 图表函数的离线单元测试。
 *
 * charts.js 之前一条离线测试都没有：统计页那点覆盖只在 e2e 里断言过
 * 「页面上有 <svg class="donut">」，等于只验了标签存在，没验图对不对。
 * 这个文件补上真正需要钉住的东西——**图上的几何和文字，跟传进去的数字是什么关系**。
 *
 * 不用真 DOM，纯函数进、字符串出，所以跑得很快。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { donutChart, legend, groupedBars, horizontalBars } from '../src/charts.js';

/** 从 horizontalBars 的输出里取出每一项的名字、宽度百分比、显示文字 */
function parseHBars(html) {
  const out = [];
  const re = /<span class="hb-name">([^<]*)<\/span>[\s\S]*?width:([\d.]+)%[\s\S]*?<span class="hb-value">([^<]*)<\/span>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    out.push({ name: m[1], width: Number(m[2]), value: m[3] });
  }
  return out;
}

/** 从 groupedBars 的输出里取出每根柱子的高度 */
function rectHeights(html) {
  return [...html.matchAll(/<rect [^>]*height="([\d.]+)"/g)].map((m) => Number(m[1]));
}

function rectFills(html) {
  return [...html.matchAll(/<rect [^>]*fill="([^"]*)"/g)].map((m) => m[1]);
}

/** 从 donutChart 的输出里取出每个扇形的 dash 长度和间隔 */
function donutSlices(html) {
  return [...html.matchAll(/stroke-dasharray="([\d.]+) ([\d.]+)"/g)].map((m) => ({
    dash: Number(m[1]),
    gap: Number(m[2]),
  }));
}

/* ------------------------------------------------------------------ */

test('horizontalBars：用 display 里的格式化文字，不要显示裸数字', () => {
  // 回归测试。normalize() 原来只挑 label/value/color，把 display 丢了，
  // 于是统计页「按人员」显示 120、「收入构成」显示 5000，
  // 而同一屏的合计写着 ¥220.00 —— 一屏里两种写法，用户看不出这是钱。
  const html = horizontalBars([
    { label: '爸爸', value: 120, display: '¥120.00' },
    { label: '妈妈', value: 40, display: '¥40.00' },
  ]);
  const rows = parseHBars(html);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].value, '¥120.00', 'display 又被丢掉了，页面上会显示裸数字');
  assert.equal(rows[1].value, '¥40.00');
});

test('horizontalBars：没给 display 时回落到裸数字，不能是 undefined 或 NaN', () => {
  const html = horizontalBars([
    { label: '爸爸', value: 120 },
    { label: '妈妈', value: 40 },
  ]);
  const rows = parseHBars(html);
  assert.equal(rows[0].value, '120');
  assert.ok(!/undefined/.test(html), '渲染出了 undefined');
  assert.ok(!/NaN/.test(html), '渲染出了 NaN');
});

test('horizontalBars：只给 total 也能用（byCategory 的形状）', () => {
  const rows = parseHBars(horizontalBars([{ fullName: '餐饮', total: 130 }]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, '餐饮');
  assert.equal(rows[0].value, '130');
});

test('horizontalBars：条宽按最大的那一项归一，比例要对', () => {
  const rows = parseHBars(horizontalBars([
    { label: '爸爸', value: 120, display: '¥120.00' },
    { label: '未指定', value: 60, display: '¥60.00' },
    { label: '妈妈', value: 40, display: '¥40.00' },
  ]));
  assert.equal(rows[0].width, 100, '最大的那项应该是满宽');
  assert.equal(rows[1].width, 50, '60 是 120 的一半，条宽也该是一半');
  assert.equal(Math.round(rows[2].width * 10) / 10, 33.3, '40/120 = 33.3%');
});

test('horizontalBars：0 和负数不画条，但也不能把整块弄没', () => {
  const html = horizontalBars([
    { label: '爸爸', value: 100, display: '¥100.00' },
    { label: '妈妈', value: 0, display: '¥0.00' },
    { label: '孩子', value: -30, display: '-¥30.00' },
  ]);
  const rows = parseHBars(html);
  assert.equal(rows.length, 1, '0 和负数不该占一行');
  assert.equal(rows[0].name, '爸爸');

  // 全都不是正数时给一句说明，不要吐一个空列表
  const empty = horizontalBars([{ label: '妈妈', value: 0 }]);
  assert.match(empty, /暂无数据/);
});

test('donutChart：扇形首尾相接，不会绕圈重叠', () => {
  const html = donutChart([
    { label: '餐饮', value: 130 },
    { label: '买菜', value: 50 },
    { label: '未分类', value: 40 },
  ]);
  const slices = donutSlices(html);
  assert.equal(slices.length, 3, `扇形数量不对，实际 ${slices.length}`);

  // 每个扇形的 dash + gap 必须等于同一个圆周长。
  // 代码是 dash.toFixed(2) 和 (circumference - dash).toFixed(2)，两者四舍五入各自
  // 取两位小数，和会差 ±0.01，所以按 0.02 的容差比较，不能要求完全相等。
  const perimeters = slices.map((s) => s.dash + s.gap);
  const spread = Math.max(...perimeters) - Math.min(...perimeters);
  assert.ok(spread <= 0.02, `圆周长不一致（差 ${spread.toFixed(4)}）：${perimeters.join(', ')}`);

  // 三个扇形加起来正好一圈（每个都留了 1.2 的缝，所以略小于一整圈）
  const total = slices.reduce((a, s) => a + s.dash, 0);
  const circumference = Math.max(...perimeters);
  assert.ok(total < circumference, '扇形加起来超过了整圈，会绕回来重叠');
  assert.ok(total > circumference * 0.98, `扇形加起来只有整圈的 ${((total / circumference) * 100).toFixed(1)}%，中间会留大缝`);
});

test('donutChart：扇形长度比例要跟数值比例一致', () => {
  const slices = donutSlices(donutChart([
    { label: '餐饮', value: 130 },
    { label: '买菜', value: 50 },
    { label: '未分类', value: 40 },
  ]));
  // 130 : 50 : 40 = 2.6 : 1 : 0.8
  const ratio = slices[0].dash / slices[1].dash;
  assert.ok(Math.abs(ratio - 2.6) < 0.05, `130/50 的比例应该是 2.6，实际 ${ratio.toFixed(3)}`);
});

test('donutChart：负数分类不画，分母用正数之和（否则会出现 148%）', () => {
  // 报销回款会把某个分类冲成负数。若仍拿合计做分母，扇形会超出整圈。
  const html = donutChart([
    { label: '餐饮', value: -200 },
    { label: '交通', value: 50 },
  ]);
  const slices = donutSlices(html);
  assert.equal(slices.length, 1, '负数分类不该出现在图上');
  assert.ok(!/NaN/.test(html), '渲染出了 NaN');
  const pct = /donut-value">(-?\d+)%/.exec(html);
  assert.ok(pct, '环形图中间没显示百分比');
  assert.ok(Number(pct[1]) <= 100, `环形图中间显示了 ${pct[1]}%，不可能超过 100%`);
});

test('legend：百分比加起来不超过 100%', () => {
  const html = legend([
    { label: '餐饮', value: 130 },
    { label: '买菜', value: 50 },
    { label: '未分类', value: 40 },
  ], 220);
  const pcts = [...html.matchAll(/lg-pct">(-?\d+)%</g)].map((m) => Number(m[1]));
  assert.equal(pcts.length, 3);
  const sum = pcts.reduce((a, b) => a + b, 0);
  assert.ok(sum <= 100, `图例百分比加起来 ${sum}%，超过了 100%`);
  assert.ok(sum >= 95, `图例百分比加起来只有 ${sum}%，掉太多了`);
});

test('groupedBars：柱高跟数值成正比', () => {
  const html = groupedBars([
    { label: '10 月', values: [4000, 200] },
    { label: '11 月', values: [5000, 220] },
  ]);
  const heights = rectHeights(html);
  assert.equal(heights.length, 4, '两个月 × 两根柱 = 4 根');

  // 收入：4000 vs 5000 → 0.8
  const incomeRatio = heights[0] / heights[2];
  assert.ok(Math.abs(incomeRatio - 0.8) < 0.02, `收入柱高比应该是 0.8，实际 ${incomeRatio.toFixed(3)}`);
  // 支出：200 vs 220 → 0.909
  const expenseRatio = heights[1] / heights[3];
  assert.ok(Math.abs(expenseRatio - 200 / 220) < 0.02, `支出柱高比应该是 0.909，实际 ${expenseRatio.toFixed(3)}`);
});

test('groupedBars：数值为 0 的柱子留一条底线，不能画成 0 高度', () => {
  const heights = rectHeights(groupedBars([{ label: '9 月', values: [0, 100] }]));
  assert.equal(heights[0], 1, '0 值柱子应该留 1px，否则完全看不见、分不清「没有」和「没画」');
  assert.ok(heights[1] > 1, '有值的柱子不该被压成 1px');
});

test('groupedBars：颜色顺序固定为「先收入后支出」', () => {
  const fills = rectFills(groupedBars([{ label: '11 月', values: [5000, 220] }]));
  assert.deepEqual(fills, ['#22c55e', '#f87171'], '第一根该是收入的绿、第二根该是支出的红');
});

test('groupedBars：空数据给提示，不吐空 SVG', () => {
  assert.match(groupedBars([]), /暂无数据/);
});

test('空数据都给提示，不要吐一个空壳', () => {
  assert.match(donutChart([]), /这个月还没有数据/);
  assert.match(donutChart([{ label: '餐饮', value: 0 }]), /这个月还没有数据/);
  assert.match(horizontalBars([]), /暂无数据/);
  assert.equal(legend([]), '', '没有数据时图例应该是空字符串');
});

test('标签里的尖括号会被转义，不会穿透成 HTML', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const donut = donutChart([{ label: evil, value: 10 }]);
  assert.ok(!donut.includes('<img'), '环形图的标签没转义');
  const bars = horizontalBars([{ label: evil, value: 10, display: evil }]);
  assert.ok(!bars.includes('<img'), '横条图的标签没转义');
  const grouped = groupedBars([{ label: evil, values: [1, 2] }]);
  assert.ok(!grouped.includes('<img'), '柱状图的横轴标签没转义');
});
