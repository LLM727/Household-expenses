/** 手写 SVG 图表：不引第三方库，国内网络下也不会白屏 */

import { escapeHtml, colorForIndex } from './utils.js';

/**
 * 统一数据形状：接受 {label|name|fullName, value|total} 两种写法
 *
 * `display` 必须原样带出来。它装的是「给人看的那个字符串」（比如 ¥120.00），
 * 而 value 是给画图算比例的裸数字。原来的实现只挑 label/value/color 三样，
 * 把 display 悄悄丢了，于是 horizontalBars 里 `d.display ?? d.value` 永远走 fallback，
 * 页面上就出现「同一屏里别处写 ¥220.00、这里写 220」——用户看不出这是钱。
 */
function normalize(items) {
  return (items || []).map((d) => ({
    label: d.label ?? d.fullName ?? d.name ?? '',
    value: Number(d.value ?? d.total ?? 0),
    display: d.display,
    color: d.color,
  }));
}

/**
 * 环形图（饼图的等价物，手机上更省空间）
 * @param {Array<{label:string,value:number,color?:string}>} items
 */
export function donutChart(items, { size = 190, thickness = 26, total: totalOverride } = {}) {
  const list = normalize(items).filter((d) => Number(d.value) > 0);
  if (!list.length) {
    return `<div class="empty-chart">这个月还没有数据</div>`;
  }
  const positiveSum = list.reduce((a, b) => a + Number(b.value), 0);
  // 分母不能小于各扇形之和，否则扇形会绕圈重叠、出现 148% 这种数字
  const total = Math.max(Number(totalOverride) || 0, positiveSum) || positiveSum;
  const r = 50 - thickness / 2;
  const circumference = 2 * Math.PI * r;
  const center = 50;

  let offset = 0;
  const slices = list.map((d, i) => {
    const frac = Number(d.value) / total;
    const len = frac * circumference;
    const color = d.color || colorForIndex(i);
    const dash = `${Math.max(len - 1.2, 0).toFixed(2)} ${(circumference - Math.max(len - 1.2, 0)).toFixed(2)}`;
    const el = `<circle cx="${center}" cy="${center}" r="${r}" fill="none" stroke="${color}"
      stroke-width="${thickness}" stroke-dasharray="${dash}"
      stroke-dashoffset="${(-offset).toFixed(2)}" stroke-linecap="butt"
      transform="rotate(-90 ${center} ${center})"></circle>`;
    offset += len;
    return el;
  }).join('');

  const top = list[0];
  return `
  <svg class="donut" viewBox="0 0 100 100" style="width:${size}px;height:${size}px" role="img"
       aria-label="${escapeHtml(list.map((d) => `${d.label} ${d.value}`).join('，'))}">
    <circle cx="${center}" cy="${center}" r="${r}" fill="none" stroke="var(--track)" stroke-width="${thickness}"></circle>
    ${slices}
    <text x="50" y="47" text-anchor="middle" class="donut-label">${escapeHtml(top.label)}</text>
    <text x="50" y="60" text-anchor="middle" class="donut-value">${((top.value / total) * 100).toFixed(0)}%</text>
  </svg>`;
}

/** 图例 */
export function legend(items, total) {
  const list = normalize(items).filter((d) => Number(d.value) > 0);
  if (!list.length) return '';
  // 同 donutChart：分母至少是各正数之和，百分比才不会超过 100%
  const positiveSum = list.reduce((a, b) => a + Number(b.value), 0);
  const base = Math.max(Number(total) || 0, positiveSum) || positiveSum;
  return `<ul class="legend">${list.map((d, i) => {
    const pct = base ? ((Number(d.value) / base) * 100).toFixed(0) : 0;
    return `<li>
      <span class="dot" style="background:${d.color || colorForIndex(i)}"></span>
      <span class="lg-name">${escapeHtml(d.label)}</span>
      <span class="lg-pct">${pct}%</span>
    </li>`;
  }).join('')}</ul>`;
}

/**
 * 分组柱状图：每组两根柱（对比两个系列，如收入/支出）
 * 用 320 宽的坐标系，容器宽度自适应（等比缩放，文字不会被拉变形）
 * @param {Array<{label:string, values:number[]}>} groups
 */
export function groupedBars(groups, { height = 150, colors = ['#22c55e', '#f87171'], seriesCount = 2 } = {}) {
  const list = groups || [];
  if (!list.length) return '<div class="empty-chart">暂无数据</div>';
  const max = Math.max(1, ...list.flatMap((g) => g.values.map((v) => Math.abs(Number(v) || 0))));
  const W = 320;
  const plotH = height - 26;
  const groupW = W / list.length;
  const barW = Math.min((groupW * 0.62) / seriesCount, 26);
  const gap = 4;

  const bars = list.map((g, gi) => {
    const baseX = gi * groupW + groupW / 2 - (barW * seriesCount + gap * (seriesCount - 1)) / 2;
    return g.values.slice(0, seriesCount).map((v, si) => {
      const value = Math.abs(Number(v) || 0);
      const h = (value / max) * plotH;
      const x = baseX + si * (barW + gap);
      const y = height - 20 - h;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}"
        height="${Math.max(h, 1).toFixed(1)}" rx="3" fill="${colors[si] || '#94a3b8'}"></rect>`;
    }).join('');
  }).join('');

  const labels = list.map((g, gi) => {
    const x = gi * groupW + groupW / 2;
    return `<text x="${x.toFixed(1)}" y="${height - 6}" text-anchor="middle" class="axis-label">${escapeHtml(g.label)}</text>`;
  }).join('');

  const gridLines = [0.25, 0.5, 0.75, 1].map((f) => {
    const y = height - 20 - f * plotH;
    return `<line x1="0" y1="${y.toFixed(1)}" x2="${W}" y2="${y.toFixed(1)}" stroke="var(--track)" stroke-width="1"></line>`;
  }).join('');

  return `
  <svg class="bars" viewBox="0 0 ${W} ${height}" preserveAspectRatio="xMidYMid meet"
       style="height:${height}px;width:100%" role="img">
    ${gridLines}
    ${bars}
    ${labels}
  </svg>`;
}

/** 横向条形图（适合按人、按分类排行） */
export function horizontalBars(items, { colors } = {}) {
  const list = normalize(items).filter((d) => Number(d.value) > 0);
  if (!list.length) return '<div class="empty-chart">暂无数据</div>';
  const max = Math.max(...list.map((d) => Number(d.value)));
  return `<ul class="hbars">${list.map((d, i) => {
    const pct = max ? (Number(d.value) / max) * 100 : 0;
    const color = d.color || (colors ? colors[i % colors.length] : colorForIndex(i));
    return `<li>
      <span class="hb-name">${escapeHtml(d.label)}</span>
      <span class="hb-track"><span class="hb-fill" style="width:${pct.toFixed(1)}%;background:${color}"></span></span>
      <span class="hb-value">${escapeHtml(d.display ?? d.value)}</span>
    </li>`;
  }).join('')}</ul>`;
}
