/** 通用小工具：日期、金额、字符串 */

export function pad2(n) {
  return String(n).padStart(2, '0');
}

export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function isoToDate(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function dateToISO(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 'YYYY-MM-DD' 或 Date -> 'YYYY-MM' */
export function monthOf(value) {
  if (value instanceof Date) return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}`;
  return String(value).slice(0, 7);
}

export function currentMonth() {
  return monthOf(new Date());
}

/** 'YYYY-MM' -> { from: 'YYYY-MM-01', to: 'YYYY-MM-最后一天' } */
export function monthRange(month) {
  const [y, m] = String(month).split('-').map(Number);
  const from = `${y}-${pad2(m)}-01`;
  const last = new Date(y, m, 0).getDate();
  const to = `${y}-${pad2(m)}-${pad2(last)}`;
  return { from, to };
}

/** 月份偏移，支持负数和跨年 */
export function shiftMonth(month, delta) {
  const [y, m] = String(month).split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

/** 近 n 个月（含当月），旧 → 新 */
export function lastMonths(n, endMonth = currentMonth()) {
  const out = [];
  for (let i = n - 1; i >= 0; i -= 1) out.push(shiftMonth(endMonth, -i));
  return out;
}

export function money(n, { sign = false, currency = '¥' } = {}) {
  const value = Number(n) || 0;
  const abs = Math.abs(value).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (sign) return `${value < 0 ? '-' : '+'}${currency}${abs}`;
  return `${value < 0 ? '-' : ''}${currency}${abs}`;
}

export function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

export function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function sumBy(list, fn) {
  return list.reduce((acc, item) => acc + (Number(fn(item)) || 0), 0);
}

/** 按 key 分组，返回 Map */
export function groupBy(list, fn) {
  const map = new Map();
  for (const item of list) {
    const key = fn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

export function colorForIndex(i) {
  const palette = [
    '#f97316', '#0ea5e9', '#22c55e', '#a855f7', '#ef4444', '#eab308',
    '#14b8a6', '#ec4899', '#6366f1', '#84cc16', '#f59e0b', '#06b6d4',
  ];
  return palette[i % palette.length];
}
