/**
 * 统计与聚合（纯函数，可单测）
 *
 * 收支口径（已与用户确认）：
 *   - 计入合计：expense（支出）、income（收入）
 *   - 报销回款（reimburse_back）不算收入，而是冲减对应分类的支出
 *   - 转账 / 借出 / 收回 / 借入 / 归还 一律不计入合计，只影响账户与债权
 */

import { KIND_MAP } from './defaults.js';
import { round2, sumBy } from './utils.js';

const COUNTED = new Set(['expense', 'income']);

export function isCounted(tx) {
  return COUNTED.has(tx.kind);
}

/** 单条账目对「支出」的贡献（报销回款为负数） */
export function expenseDelta(tx) {
  if (tx.kind === 'expense') return Number(tx.amount) || 0;
  if (tx.kind === 'reimburse_back') return -(Number(tx.amount) || 0);
  return 0;
}

/** 单条账目对「收入」的贡献 */
export function incomeDelta(tx) {
  return tx.kind === 'income' ? Number(tx.amount) || 0 : 0;
}

/** 总体合计 */
export function totals(transactions) {
  const list = transactions || [];
  const expense = round2(sumBy(list, expenseDelta));
  const income = round2(sumBy(list, incomeDelta));
  const special = {};
  for (const tx of list) {
    if (!isCounted(tx)) {
      special[tx.kind] = round2((special[tx.kind] || 0) + (Number(tx.amount) || 0));
    }
  }
  return {
    expense,
    income,
    net: round2(income - expense),
    special,
    count: list.length,
  };
}

/** 分类字典：id -> {id, name, fullName, icon, kind, parent_id} */
export function categoryMap(categories) {
  const list = categories || [];
  const byId = new Map(list.map((c) => [c.id, c]));
  const map = new Map();
  for (const c of list) {
    const parent = c.parent_id ? byId.get(c.parent_id) : null;
    map.set(c.id, {
      ...c,
      parentName: parent ? parent.name : null,
      fullName: parent ? `${parent.name}·${c.name}` : c.name,
      icon: (parent && parent.icon) || c.icon || '',
    });
  }
  return map;
}

/**
 * 按分类聚合支出/收入。
 * @returns {Array<{categoryId, name, icon, total, kind}>} 金额降序
 */
export function byCategory(transactions, categories, kind = 'expense') {
  const cmap = categoryMap(categories);
  const buckets = new Map();
  for (const tx of transactions || []) {
    let value = 0;
    if (kind === 'expense') value = expenseDelta(tx);
    else if (kind === 'income') value = incomeDelta(tx);
    else value = COUNTED.has(tx.kind) ? Number(tx.amount) || 0 : 0;
    if (!value) continue;
    const key = tx.category_id || '__none__';
    if (!buckets.has(key)) {
      const cat = tx.category_id ? cmap.get(tx.category_id) : null;
      buckets.set(key, {
        categoryId: tx.category_id || null,
        name: cat ? cat.name : kind === 'income' ? '其他收入' : '未分类',
        fullName: cat ? cat.fullName : kind === 'income' ? '其他收入' : '未分类',
        icon: cat?.icon || '📦',
        kind,
        total: 0,
      });
    }
    buckets.get(key).total = round2(buckets.get(key).total + value);
  }
  return [...buckets.values()].filter((b) => b.total !== 0).sort((a, b) => b.total - a.total);
}

/** 按成员聚合 */
export function byMember(transactions, members, kind = 'expense') {
  const mmap = new Map((members || []).map((m) => [m.id, m]));
  const buckets = new Map();
  for (const tx of transactions || []) {
    const value = kind === 'expense' ? expenseDelta(tx) : incomeDelta(tx);
    if (!value) continue;
    const key = tx.member_id || '__none__';
    if (!buckets.has(key)) {
      const m = tx.member_id ? mmap.get(tx.member_id) : null;
      buckets.set(key, {
        memberId: tx.member_id || null,
        name: m ? m.display_name : '未指定',
        role: m?.role || null,
        kind,
        total: 0,
      });
    }
    buckets.get(key).total = round2(buckets.get(key).total + value);
  }
  return [...buckets.values()].filter((b) => b.total !== 0).sort((a, b) => b.total - a.total);
}

/** 按月份聚合，返回按月份升序 */
export function byMonth(transactions, months) {
  const buckets = new Map((months || []).map((m) => [m, { month: m, income: 0, expense: 0 }]));
  for (const tx of transactions || []) {
    const month = String(tx.occurred_on).slice(0, 7);
    if (!buckets.has(month)) buckets.set(month, { month, income: 0, expense: 0 });
    const bucket = buckets.get(month);
    bucket.expense = round2(bucket.expense + expenseDelta(tx));
    bucket.income = round2(bucket.income + incomeDelta(tx));
  }
  for (const bucket of buckets.values()) bucket.net = round2(bucket.income - bucket.expense);
  return [...buckets.values()].sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
}

/** 按天聚合（当前月每天支出），用于柱状图 */
export function byDay(transactions, month) {
  const [y, m] = String(month).split('-').map(Number);
  const days = new Date(y, m, 0).getDate();
  const arr = Array.from({ length: days }, (_, i) => ({
    day: i + 1,
    date: `${y}-${String(m).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`,
    expense: 0,
    income: 0,
  }));
  for (const tx of transactions || []) {
    if (String(tx.occurred_on).slice(0, 7) !== month) continue;
    const day = Number(String(tx.occurred_on).slice(8, 10));
    if (!arr[day - 1]) continue;
    arr[day - 1].expense = round2(arr[day - 1].expense + expenseDelta(tx));
    arr[day - 1].income = round2(arr[day - 1].income + incomeDelta(tx));
  }
  return arr;
}

/**
 * 预算执行情况。
 * @param {Array} budgets  [{category_id, amount}]
 * @param {Array} transactions 当月账目
 * @param {Array} categories
 * @param {number} warnRatio 达到多少比例算「即将超支」
 */
export function budgetStatus(budgets, transactions, categories, warnRatio = 0.8) {
  const cmap = categoryMap(categories);
  const catTotals = new Map();
  for (const tx of transactions || []) {
    if (!tx.category_id) continue;
    const value = expenseDelta(tx);
    if (!value) continue;
    catTotals.set(tx.category_id, round2((catTotals.get(tx.category_id) || 0) + value));
  }

  // 分类预算要「往下汇总」：界面上只能给大类（餐饮、交通…）设预算，
  // 而记账时钱几乎都落在小类上（餐饮/买菜、餐饮/在外吃饭）。
  // 只按 category_id 精确相等去加，等于大类预算永远显示 0 已用、永远不超支——
  // 用户设了预算却什么都没发生，比没有这个功能更糟。
  const ancestors = new Map(); // 分类 id -> 它的各级上级 id
  for (const c of categories || []) {
    const chain = [];
    let cur = c.parent_id ? cmap.get(c.parent_id) : null;
    let guard = 0;
    while (cur && guard < 10) {
      chain.push(cur.id);
      cur = cur.parent_id ? cmap.get(cur.parent_id) : null;
      guard += 1;
    }
    ancestors.set(c.id, chain);
  }
  const rollup = new Map(); // 分类 id -> 该分类自身加上所有下级分类的合计
  for (const [catId, amount] of catTotals) {
    rollup.set(catId, round2((rollup.get(catId) || 0) + amount));
    for (const anc of ancestors.get(catId) || []) {
      rollup.set(anc, round2((rollup.get(anc) || 0) + amount));
    }
  }

  return (budgets || []).map((b) => {
    const used = b.category_id
      ? rollup.get(b.category_id) || 0
      : round2(sumBy(transactions || [], expenseDelta));
    const ratio = b.amount > 0 ? used / b.amount : 0;
    const cat = b.category_id ? cmap.get(b.category_id) : null;
    return {
      budgetId: b.id,
      categoryId: b.category_id || null,
      name: cat ? cat.fullName : '总预算',
      icon: cat?.icon || '🎯',
      amount: round2(b.amount),
      used: round2(used),
      remaining: round2(b.amount - used),
      ratio: Math.round(ratio * 1000) / 1000,
      state: ratio >= 1 ? 'over' : ratio >= warnRatio ? 'warn' : 'ok',
    };
  }).sort((a, b) => b.ratio - a.ratio);
}

/**
 * 分类 × 月份的趋势表：取总额最高的前 topN 个分类，逐月列出金额。
 * @returns {{months:string[], rows:Array<{categoryId,name,icon,values:number[],total:number}>}}
 */
export function categoryTrend(transactions, categories, months, topN = 5) {
  const cmap = categoryMap(categories);
  const monthList = months || [];
  const bucket = new Map(); // categoryId -> Map(month -> amount)

  for (const tx of transactions || []) {
    const value = expenseDelta(tx);
    if (!value) continue;
    const month = String(tx.occurred_on).slice(0, 7);
    if (!monthList.includes(month)) continue;
    const key = tx.category_id || '__none__';
    if (!bucket.has(key)) bucket.set(key, new Map());
    const inner = bucket.get(key);
    inner.set(month, round2((inner.get(month) || 0) + value));
  }

  const rows = [...bucket.entries()].map(([categoryId, inner]) => {
    const cat = categoryId === '__none__' ? null : cmap.get(categoryId);
    const values = monthList.map((m) => round2(inner.get(m) || 0));
    return {
      categoryId: categoryId === '__none__' ? null : categoryId,
      name: cat ? cat.fullName : '未分类',
      icon: cat?.icon || '📦',
      values,
      total: round2(values.reduce((a, b) => a + b, 0)),
    };
  });

  rows.sort((a, b) => b.total - a.total);
  return { months: monthList, rows: rows.slice(0, topN) };
}

/** 环比：与上一个月对比 */export function compareWithPrev(current, previous) {
  const now = totals(current);
  const prev = totals(previous);
  const pct = (cur, old) => {
    if (!old) return cur ? 1 : 0;
    return Math.round(((cur - old) / Math.abs(old)) * 1000) / 10;
  };
  return {
    expense: { current: now.expense, previous: prev.expense, pct: pct(now.expense, prev.expense) },
    income: { current: now.income, previous: prev.income, pct: pct(now.income, prev.income) },
    net: { current: now.net, previous: prev.net, pct: pct(now.net, prev.net) },
  };
}

export { KIND_MAP };

/* ------------------------------------------------------------------ */
/* 账户余额                                                           */
/* ------------------------------------------------------------------ */

/**
 * 按账目推算各账户余额（转账会同时扣转出、加转入）。
 * @returns {Array<{id,name,kind,balance}>}
 */
export function accountBalances(transactions, accounts) {
  const balances = new Map((accounts || []).map((a) => [a.id, round2(Number(a.initial_balance) || 0)]));
  const bump = (id, delta) => {
    if (!id || !balances.has(id)) return;
    balances.set(id, round2(balances.get(id) + delta));
  };

  for (const tx of transactions || []) {
    const amount = Number(tx.amount) || 0;
    switch (tx.kind) {
      case 'expense':
        bump(tx.account_id, -amount);
        break;
      case 'income':
        bump(tx.account_id, amount);
        break;
      case 'transfer':
        bump(tx.account_id, -amount);
        bump(tx.to_account_id, amount);
        break;
      case 'lend':
      case 'borrow_return':
        bump(tx.account_id, -amount);
        break;
      case 'lend_return':
      case 'borrow':
      case 'reimburse_back':
        bump(tx.account_id, amount);
        break;
      default:
        break;
    }
  }

  return (accounts || []).map((a) => ({
    id: a.id,
    name: a.name,
    kind: a.kind,
    balance: balances.get(a.id) ?? 0,
  }));
}
