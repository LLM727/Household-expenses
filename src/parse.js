/**
 * 自然语言记账解析器（纯函数，无外部依赖，浏览器与 Node 通用）
 *
 * 目标：把「11月8日购买牛奶花了35.5元」这类句子，解析成一条可确认的账目草稿。
 * 设计原则：解析结果一律当作「草稿」交给用户确认，不静默入库。
 */

import { KIND_MAP, ROLES } from './defaults.js';

/* ------------------------------------------------------------------ */
/* 基础工具                                                           */
/* ------------------------------------------------------------------ */

const CN_DIGITS = { 零: 0, 〇: 0, 一: 1, 幺: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function pad2(n) {
  return String(n).padStart(2, '0');
}

export function toISODate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function parseISODate(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(iso, delta) {
  const d = parseISODate(iso);
  d.setDate(d.getDate() + delta);
  return toISODate(d);
}

function normalize(text) {
  return String(text || '')
    .replace(/[\uFF10-\uFF19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)) // 全角数字
    .replace(/[，、；;]/g, '，')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/\s+/g, ' ')
    .trim();
}

/** 中文数字转阿拉伯数字，支持 三十 / 一百五 / 三千 / 一万二 等常见写法 */
export function cnToNumber(str) {
  let total = 0;
  let section = 0;
  let number = 0;
  let last = 0; // 记录上一位单位，用于「一万二」= 12000 这类省略
  for (const ch of str) {
    if (ch === '万') {
      section = (section + number) * 10000;
      total += section;
      section = 0;
      number = 0;
      last = 10000;
    } else if (ch === '千') {
      section += (number || 1) * 1000;
      number = 0;
      last = 1000;
    } else if (ch === '百') {
      section += (number || 1) * 100;
      number = 0;
      last = 100;
    } else if (ch === '十') {
      section += (number || 1) * 10;
      number = 0;
      last = 10;
    } else if (ch in CN_DIGITS) {
      if (last >= 100 && number === 0) {
        // 「一万二」=> 12000：省略单位时按上一位单位折算
        section += CN_DIGITS[ch] * (last / 10);
      } else {
        number = CN_DIGITS[ch];
      }
      last = 0;
    }
  }
  return total + section + number;
}

function maskSpans(text, spans) {
  if (!spans.length) return text;
  const chars = text.split('');
  for (const [start, end] of spans) {
    for (let i = start; i < end && i < chars.length; i += 1) chars[i] = ' ';
  }
  return chars.join('');
}

/* ------------------------------------------------------------------ */
/* 日期                                                               */
/* ------------------------------------------------------------------ */

const REL_DAYS = [
  ['大前天', -3],
  ['前天', -2],
  ['昨天', -1],
  ['昨日', -1],
  ['昨儿', -1],
  ['今天', 0],
  ['今日', 0],
  ['今儿', 0],
  ['当天', 0],
];

/**
 * 提取发生日期。返回 { date: 'YYYY-MM-DD', span: [start,end], source: '原文片段' } | null
 */
export function extractDate(text, todayISO) {
  const today = parseISODate(todayISO);

  // 1) 2026年11月8日 / 2026-11-08 / 2026/11/8
  let m = text.match(/(\d{4})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*[日号]?/);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (!Number.isNaN(d.getTime())) {
      return { date: toISODate(d), span: [m.index, m.index + m[0].length], source: m[0] };
    }
  }

  // 2) 11月8日 / 11月8号 / 11月8
  m = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/);
  if (m) {
    const month = Number(m[1]);
    const day = Number(m[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      let year = today.getFullYear();
      let d = new Date(year, month - 1, day);
      // 补录：若算出来晚于今天，视为去年的账
      if (d.getTime() > today.getTime()) d = new Date(year - 1, month - 1, day);
      if (!Number.isNaN(d.getTime())) {
        return { date: toISODate(d), span: [m.index, m.index + m[0].length], source: m[0] };
      }
    }
  }

  // 3) 相对日期
  for (const [word, delta] of REL_DAYS) {
    const idx = text.indexOf(word);
    if (idx >= 0) {
      return { date: addDays(todayISO, delta), span: [idx, idx + word.length], source: word };
    }
  }

  // 4) 只有「8号」这种
  m = text.match(/(?:^|[^\d])(\d{1,2})\s*[日号]/);
  if (m) {
    const day = Number(m[1]);
    if (day >= 1 && day <= 31) {
      let d = new Date(today.getFullYear(), today.getMonth(), day);
      if (d.getTime() > today.getTime()) {
        d = new Date(today.getFullYear(), today.getMonth() - 1, day);
      }
      if (!Number.isNaN(d.getTime())) {
        const start = m.index + (m[0].length - m[0].replace(/^[^\d]/, '').length);
        return { date: toISODate(d), span: [start, m.index + m[0].length], source: m[1] + '号' };
      }
    }
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* 金额                                                               */
/* ------------------------------------------------------------------ */

const AMOUNT_RE = /(\d+(?:\.\d+)?)\s*(万|千|w|W|k|K)?\s*(元|块钱|块|圆|人民币|rmb|RMB|¥|￥)?/g;

/** 把「三十块」这类中文数字先转成阿拉伯数字，仅处理后面跟货币单位的 */
function normalizeChineseAmounts(text) {
  return text.replace(/([零〇一幺二两三四五六七八九十百千万]+)\s*(元|块钱|块|圆|人民币|¥|￥)/g, (whole, cn) => {
    const num = cnToNumber(cn);
    return Number.isFinite(num) && num > 0 ? String(num) + whole.slice(cn.length) : whole;
  });
}

/**
 * 提取金额。返回 { amount, span, source, candidates }
 * 优先取「带货币单位」的数字中最大的一个；没有单位时取最大的裸数字。
 */
export function extractAmount(text) {
  const candidates = [];
  let m;
  AMOUNT_RE.lastIndex = 0;
  while ((m = AMOUNT_RE.exec(text)) !== null) {
    const raw = Number(m[1]);
    if (!Number.isFinite(raw)) continue;
    let value = raw;
    if (m[2] === '万' || m[2] === 'w' || m[2] === 'W') value = raw * 10000;
    else if (m[2] === '千' || m[2] === 'k' || m[2] === 'K') value = raw * 1000;
    candidates.push({
      value: Math.round(value * 100) / 100,
      hasCurrency: Boolean(m[3]),
      span: [m.index, m.index + m[0].length],
      source: m[0].trim(),
    });
  }
  if (!candidates.length) return null;

  const withCurrency = candidates.filter((c) => c.hasCurrency);
  const pool = withCurrency.length ? withCurrency : candidates.filter((c) => c.value >= 1);
  if (!pool.length) return null;
  const best = pool.reduce((a, b) => (b.value > a.value ? b : a));
  const ambiguous = new Set(pool.map((c) => c.value)).size > 1;
  return { ...best, candidates, ambiguous };
}

/* ------------------------------------------------------------------ */
/* 收支类型                                                           */
/* ------------------------------------------------------------------ */

/**
 * 顺序有意义：先判特殊类型（转账/借还/报销），再判收入，最后默认支出。
 */
const KIND_RULES = [
  { kind: 'transfer', re: /(转账|转入|转出|转到|转给|提现|充值|存到|取现|零钱通)/ },
  { kind: 'lend_return', re: /(收回借款|还给我|还款给我|把钱还我|回来了钱)/ },
  { kind: 'lend', re: /(借给|借出|借钱给|借了.{0,8}给)/ },
  { kind: 'borrow_return', re: /(归还借款|还了钱|还钱|还款|还清)/ },
  { kind: 'borrow', re: /((向|跟|找).{0,8}借|借入|借了|借来)/ },
  { kind: 'reimburse_back', re: /(报销回来|报销回款|报销到账|报销退了|报销给我|报回来了)/ },
  { kind: 'income', re: /(收到|收入|进账|入账|发工资|发了工资|工资|薪水|奖金|年终奖|提成|绩效|补贴|津贴|利息|分红|收益|红包|压岁钱|赚了|返现|退款)/ },
];

/** 垫付（属于支出，但标记可报销） */
const REIMBURSE_CLAIM_RE = /(垫付|先垫|报销用|要报销|可以报销)/;

export function detectKind(text) {
  for (const rule of KIND_RULES) {
    const m = text.match(rule.re);
    if (m) return { kind: rule.kind, span: [m.index, m.index + m[0].length], source: m[0] };
  }
  return { kind: 'expense', span: null, source: null };
}

/* ------------------------------------------------------------------ */
/* 分类                                                               */
/* ------------------------------------------------------------------ */

/**
 * @param {string} text
 * @param {Array} categories 形如 [{id,name,kind,parent_id,parentName,fullName,keywords:[]}]
 */
export function matchCategory(text, categories, kind) {
  const usable = categories.filter((c) => !kind || c.kind === kind || c.kind === 'expense' && kind === 'expense');
  let best = null;
  for (const cat of usable) {
    const names = [cat.name, ...(cat.keywords || [])].filter(Boolean);
    for (const kw of names) {
      const idx = text.indexOf(kw);
      if (idx < 0) continue;
      // 词越长越可信；同长度时小类（有 parent_id）优先
      const score = kw.length * 10 + (cat.parent_id ? 3 : 0);
      if (!best || score > best.score) {
        best = { cat, score, kw, idx };
      }
    }
  }
  if (!best) return null;
  return {
    categoryId: best.cat.id,
    categoryName: best.cat.name,
    categoryFullName: best.cat.fullName || best.cat.name,
    span: [best.idx, best.idx + best.kw.length],
    source: best.kw,
  };
}

/* ------------------------------------------------------------------ */
/* 成员                                                               */
/* ------------------------------------------------------------------ */

export function matchMember(text, members) {
  if (!members || !members.length) return null;
  const dict = [];
  for (const m of members) {
    dict.push({ member: m, word: m.display_name });
    const role = ROLES.find((r) => r.key === m.role);
    if (role) for (const alias of role.aliases) dict.push({ member: m, word: alias });
  }
  dict.sort((a, b) => b.word.length - a.word.length);
  for (const { member, word } of dict) {
    if (!word) continue;
    const idx = text.indexOf(word);
    if (idx >= 0) {
      return { memberId: member.id, memberName: member.display_name, span: [idx, idx + word.length], source: word };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 账户                                                               */
/* ------------------------------------------------------------------ */

const FROM_HINT = /(从|由|用|从银行卡|转出|取出)/;
const TO_HINT = /(到|进|转到|转入|存到|存入|打到)/;

/**
 * 从原话里认账户，例如「从银行卡转账500到微信」。
 * @param {string} text
 * @param {Array<{id:string,name:string}>} accounts
 * @returns {{fromAccountId?:string, toAccountId?:string, spans:Array}|null}
 */
export function matchAccounts(text, accounts) {
  if (!accounts || !accounts.length) return null;
  const hits = [];
  for (const acc of accounts) {
    if (!acc?.name) continue;
    const idx = text.indexOf(acc.name);
    if (idx < 0) continue;
    hits.push({ acc, idx, len: acc.name.length });
  }
  if (!hits.length) return null;
  hits.sort((a, b) => a.idx - b.idx);
  const spans = hits.map((h) => [h.idx, h.idx + h.len]);

  if (hits.length >= 2) {
    const [first, second] = hits;
    const beforeFirst = text.slice(Math.max(0, first.idx - 6), first.idx);
    // 「转到微信，从银行卡」这类倒装：第一个其实是目标账户
    const swapped = TO_HINT.test(beforeFirst) && !FROM_HINT.test(beforeFirst);
    return {
      fromAccountId: swapped ? second.acc.id : first.acc.id,
      toAccountId: swapped ? first.acc.id : second.acc.id,
      spans,
    };
  }

  const only = hits[0];
  const before = text.slice(Math.max(0, only.idx - 6), only.idx);
  if (FROM_HINT.test(before) && !TO_HINT.test(before)) {
    return { fromAccountId: only.acc.id, toAccountId: undefined, spans };
  }
  if (TO_HINT.test(before)) {
    return { fromAccountId: undefined, toAccountId: only.acc.id, spans };
  }
  return { fromAccountId: only.acc.id, toAccountId: undefined, spans };
}

/* ------------------------------------------------------------------ */
/* 备注                                                               */
/* ------------------------------------------------------------------ */

const NOTE_FILLERS = [
  /(花了|花费|花掉|买了|购买|支付了|支付|付款|付了|一共|总共|共计|合计|收到|赚了|消费|入账|记账|记一笔)/g,
  /(人民币|块钱|元|块|圆|¥|￥)/g,
  /[，。,.!！?？、:：;；~～\-—_]/g,
];

function buildNote(text, spans) {
  let rest = maskSpans(text, spans.filter(Boolean));
  for (const re of NOTE_FILLERS) rest = rest.replace(re, ' ');
  rest = rest.replace(/\s+/g, ' ').trim();
  rest = rest.replace(/^(了|的|在|于|给|把|和|跟)+\s*/g, '').trim();
  rest = rest.replace(/\s*(了|的)$/g, '').trim();
  return rest.slice(0, 80);
}

/* ------------------------------------------------------------------ */
/* 主入口                                                             */
/* ------------------------------------------------------------------ */

/**
 * @param {string} raw 用户输入的原话
 * @param {object} ctx
 * @param {string} ctx.today           今天，YYYY-MM-DD
 * @param {Array}  ctx.members         [{id, display_name, role}]
 * @param {Array}  ctx.categories      [{id, name, kind, parent_id, parentName, fullName, keywords}]
 * @returns {object} 账目草稿
 */
export function parseEntry(raw, ctx = {}) {
  const todayISO = ctx.today || toISODate(new Date());
  const members = ctx.members || [];
  const categories = ctx.categories || [];
  const warnings = [];

  const text = normalizeChineseAmounts(normalize(raw));
  if (!text) {
    return {
      ok: false,
      kind: 'expense',
      amount: null,
      occurredOn: todayISO,
      note: '',
      confidence: 0,
      warnings: ['没有识别到内容，请重新输入'],
      matches: {},
      raw,
    };
  }

  const dateHit = extractDate(text, todayISO);
  const dateSpans = dateHit ? [dateHit.span] : [];

  const kindHit = detectKind(text);
  const kind = kindHit.kind;

  const amountHit = extractAmount(maskSpans(text, dateSpans));
  const memberHit = matchMember(text, members);
  const accHit = matchAccounts(maskSpans(text, dateSpans), ctx.accounts || []);
  const isSpecial = !KIND_MAP[kind]?.counted;
  const catHit = isSpecial ? null : matchCategory(maskSpans(text, dateSpans), categories, kind);

  const spans = [dateHit?.span, amountHit?.span, memberHit?.span, kindHit?.span, catHit?.span,
    ...(accHit?.spans || [])];
  const note = buildNote(text, spans);

  if (!amountHit) warnings.push('没识别到金额，请手动填写');
  if (amountHit?.ambiguous) warnings.push('识别到多个金额，已取最大的一个，请核对');
  if (!dateHit) warnings.push('没识别到日期，默认记为今天');
  if (kind === 'expense' && !catHit) warnings.push('没识别到分类，已归到「其他支出」，可手动改');
  if (isSpecial) warnings.push(`${KIND_MAP[kind]?.name || kind}不计入家庭收支合计，只调整账户余额`);
  if (kind === 'transfer' && !accHit) warnings.push('没认出转出/转入账户，请手动选一下');
  if (REIMBURSE_CLAIM_RE.test(text)) warnings.push('疑似垫付待报销，已标记「可报销」');

  let confidence = 0.35;
  if (amountHit) confidence += 0.25;
  if (dateHit) confidence += 0.15;
  if (catHit) confidence += 0.15;
  if (memberHit) confidence += 0.05;
  if (kindHit.source) confidence += 0.05;
  confidence = Math.min(0.98, Math.round(confidence * 100) / 100);
  confidence = Math.max(0.05, confidence - warnings.length * 0.04);

  return {
    ok: Boolean(amountHit),
    raw,
    kind,
    kindName: KIND_MAP[kind]?.name || kind,
    amount: amountHit ? amountHit.value : null,
    occurredOn: dateHit ? dateHit.date : todayISO,
    categoryId: catHit ? catHit.categoryId : null,
    categoryName: catHit ? catHit.categoryName : isSpecial ? '' : '其他支出',
    categoryFullName: catHit ? catHit.categoryFullName : isSpecial ? '' : '其他支出',
    memberId: memberHit ? memberHit.memberId : null,
    memberName: memberHit ? memberHit.memberName : '',
    fromAccountId: accHit?.fromAccountId || null,
    toAccountId: accHit?.toAccountId || null,
    note,
    reimbursable: REIMBURSE_CLAIM_RE.test(text),
    confidence,
    warnings,
    matches: {
      date: dateHit ? dateHit.source : null,
      amount: amountHit ? amountHit.source : null,
      category: catHit ? catHit.source : null,
      member: memberHit ? memberHit.source : null,
      kind: kindHit.source,
    },
  };
}
