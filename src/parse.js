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
  const chars = Array.from(String(str || ''));
  let total = 0;
  let section = 0;
  let number = 0;
  let last = 0; // 记录上一位单位，用于「一万二」= 12000 这类省略
  chars.forEach((ch, i) => {
    const isLast = i === chars.length - 1;
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
      // 「一万二」= 12000、「三百五」= 350：只有这个数字是整串的**最后一个字**时，
      // 才按上一位单位折算。否则「二百六十八」的「六」会被当成省略写法，算成 278。
      if (last >= 100 && number === 0 && isLast) {
        section += CN_DIGITS[ch] * (last / 10);
      } else {
        number = CN_DIGITS[ch];
      }
      last = 0;
    }
  });
  return total + section + number;
}

const CJK_RE = /[\u4e00-\u9fa5]/;

/** 这一格是不是被汉字夹在中间（单字关键词靠它判断自己是不是一个独立的词） */
function inMiddleOfWord(text, idx) {
  const before = idx > 0 ? text[idx - 1] : '';
  const after = idx + 1 < text.length ? text[idx + 1] : '';
  return CJK_RE.test(before) && CJK_RE.test(after);
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

  // 2.5) 上个月8号 / 上月8号 —— 补录时最常这么说。
  // 必须排在「只有8号」前面，否则会被当成当前月的 8 号，账就记到错月份去了。
  m = text.match(/(上上个月|上个月|上月)\s*(\d{1,2})\s*[日号]/);
  if (m) {
    const monthsBack = m[1] === '上上个月' ? 2 : 1;
    const day = Number(m[2]);
    if (day >= 1 && day <= 31) {
      const targetMonth = today.getMonth() - monthsBack;
      const lastDay = new Date(today.getFullYear(), targetMonth + 1, 0).getDate();
      const d = new Date(today.getFullYear(), targetMonth, Math.min(day, lastDay));
      if (!Number.isNaN(d.getTime())) {
        return { date: toISODate(d), span: [m.index, m.index + m[0].length], source: m[0] };
      }
    }
  }

  // 3) 9.5号 / 9/5号 —— 「月.日」的简写（先说月份，否则会被下面的「5号」抢走，记成当月）
  m = text.match(/(\d{1,2})\s*[./]\s*(\d{1,2})\s*[日号]/);
  if (m) {
    const month = Number(m[1]);
    const day = Number(m[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      let d = new Date(today.getFullYear(), month - 1, day);
      if (d.getTime() > today.getTime()) d = new Date(today.getFullYear() - 1, month - 1, day);
      if (!Number.isNaN(d.getTime())) {
        return { date: toISODate(d), span: [m.index, m.index + m[0].length], source: m[0] };
      }
    }
  }

  // 4) 上周三 / 这周五 / 星期天 —— 星期几的说法
  m = text.match(/(上上|上个|上|这|本)?(?:周|星期|礼拜)([一二三四五六日天])/);
  if (m) {
    const target = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 }[m[2]];
    const prefix = m[1] || '';
    const weeksBack = prefix === '上上' ? 2 : prefix === '上' || prefix === '上个' ? 1 : 0;
    const diff = (today.getDay() - target + 7) % 7; // 本周的这一天往前数几天
    return {
      date: addDays(todayISO, -(diff + weeksBack * 7)),
      span: [m.index, m.index + m[0].length],
      source: m[0],
    };
  }

  // 5) 相对日期
  for (const [word, delta] of REL_DAYS) {
    const idx = text.indexOf(word);
    if (idx >= 0) {
      return { date: addDays(todayISO, delta), span: [idx, idx + word.length], source: word };
    }
  }

  // 6) 只有「8号」这种
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

const CN_NUM_CHARS = '零〇一幺二两三四五六七八九十百千万';

/** 把「三十五块」「两百」这类中文数字先转成阿拉伯数字（含口语里的小数：35块5 = 35.5） */
function normalizeChineseAmounts(text) {
  return (
    text
      // 「三十五块五」「四十二块八毛」：单位后面跟一个数字，是「角」
      .replace(
        new RegExp(`([${CN_NUM_CHARS}]+)\\s*(元|块钱|块|圆|人民币|¥|￥)\\s*([一二三四五六七八九])\\s*([毛角])?`, 'g'),
        (whole, cn, _unit, frac) => {
          const num = cnToNumber(cn);
          if (!Number.isFinite(num) || num <= 0) return whole;
          return `${num}.${CN_DIGITS[frac]}`;
        },
      )
      // 阿拉伯数字也一样：「199块6」= 199.6
      .replace(/(\d+)\s*(元|块钱|块|圆)\s*([1-9])\s*([毛角])?(?!\d)/g, (whole, num, _unit, frac) => `${num}.${frac}`)
      // 普通的中文数字 + 单位
      .replace(new RegExp(`([${CN_NUM_CHARS}]+)\\s*(元|块钱|块|圆|人民币|¥|￥)`, 'g'), (whole, cn) => {
        const num = cnToNumber(cn);
        return Number.isFinite(num) && num > 0 ? String(num) + whole.slice(cn.length) : whole;
      })
  );
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
  if (!candidates.length) {
    // 语音里常见「昨天加油三百」——不带「元/块」的中文数字。
    // 排除「两个」「十点」「三斤」这类量词和时间说法，免得把数量当金额。
    const CN_AMOUNT_RE = new RegExp(
      `([${CN_NUM_CHARS}]{1,8})(?![月日号点岁个斤两人次天年分时秒成倍折共双件只条瓶袋盒张本包桶箱支根套辆台部位篇章])`,
      'g',
    );
    let cm;
    while ((cm = CN_AMOUNT_RE.exec(text)) !== null) {
      const value = cnToNumber(cm[1]);
      if (!Number.isFinite(value) || value <= 0 || value >= 1e8) continue;
      candidates.push({
        value: Math.round(value * 100) / 100,
        hasCurrency: false,
        span: [cm.index, cm.index + cm[1].length],
        source: cm[1],
      });
    }
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
  {
    // 账户之间的挪动（不算收支）。除了「转账」这类明说的词，
    // 还要认「银行卡转支付宝」「从银行卡取500现金」这种口语说法——
    // 认成支出的话，家庭总支出会凭空多出一笔。
    kind: 'transfer',
    re: /(转账|转入|转出|转到|转给|提现|充值|存到|取现|零钱通|银行卡.{0,6}转|转.{0,6}(支付宝|微信|银行卡|余额宝|信用卡)|取.{0,4}现金|存.{0,4}现金)/,
  },
  {
    // 别人还我钱（收回借出的）。要排在「借出」和「还钱」前面：
    // 「妈妈还我200」= 她还我，不是我又借出、也不是我支出。
    kind: 'lend_return',
    re: /(收回借出|收回借款|收回借|还我|还给我|把钱还我|借款回来了|钱收回来了)/,
  },
  { kind: 'lend', re: /(借给|借出|借钱给|借了.{0,8}给)/ },
  {
    // 我还别人钱（归还借入）。「我还妈妈150」「还给妈妈」都算——
    // 这不是消费，记成支出会让当月支出虚高。
    kind: 'borrow_return',
    // 「我还妈妈150」是归还；但「我还剩200」不是在还钱，所以排除「剩/有」
    re: /(归还|还给|我还(?![剩有])|还钱|还款|还清|还了钱)/,
  },
  { kind: 'borrow', re: /((向|跟|找).{0,8}借|借入|借了|借来)/ },
  { kind: 'reimburse_back', re: /(报销回来|报销回款|报销到账|报销退了|报销给我|报回来了)/ },
  { kind: 'income', re: /(收到|收入|进账|入账|发工资|发了工资|工资|薪水|奖金|年终奖|提成|绩效|补贴|津贴|利息|分红|收益|红包|压岁钱|赚了|返现|退款)/ },
];

/** 垫付（属于支出，但标记可报销） */
const REIMBURSE_CLAIM_RE = /(垫付|先垫|报销用|要报销|可以报销|可报销|报销)/;

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
      let from = 0;
      let idx = text.indexOf(kw, from);
      while (idx >= 0) {
        // 单字关键词（买、饭）太容易撞进别的词里：「电饭锅」的「饭」会被认成餐饮。
        // 要求它别被汉字夹在中间（词首、词尾都算命中）。
        if (!(kw.length === 1 && inMiddleOfWord(text, idx))) {
          // 词越长越可信；同长度时小类（有 parent_id）优先
          const score = kw.length * 10 + (cat.parent_id ? 3 : 0);
          if (!best || score > best.score) best = { cat, score, kw, idx };
          break;
        }
        from = idx + 1;
        idx = text.indexOf(kw, from);
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
  // 关键词抠完剩下的单字基本都是噪声：「交电费」剩「交」、「充话费」剩「充」、
  // 「买衣服」剩「买」。与其在流水里显示一个孤零零的字，不如留空。
  if (rest.length === 1 && /[\u4e00-\u9fa5]/.test(rest)) rest = '';
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

  // 单字的分类关键词（比如「买」「饭」）只用来判类别，不要从备注里抠掉：
  // 一抠就把词切碎了——「午饭 25」的备注变成「午」，「买菜 35.5」变成「菜」。
  const catSpan = catHit && (catHit.source || '').length > 1 ? catHit.span : null;
  const spans = [dateHit?.span, amountHit?.span, memberHit?.span, kindHit?.span, catSpan,
    ...(accHit?.spans || [])];
  const note = buildNote(text, spans);

  // 「报销」既可能是垫付待报销（支出），也可能是报销回款（抵支出）。
  // 只有前者才标记「可报销」；已经是 reimburse_back 的就别再标一遍。
  const claimHit = kind !== 'reimburse_back' && REIMBURSE_CLAIM_RE.test(text);

  if (!amountHit) warnings.push('没识别到金额，请手动填写');
  if (amountHit?.ambiguous) warnings.push('识别到多个金额，已取最大的一个，请核对');
  if (!dateHit) warnings.push('没识别到日期，默认记为今天');
  if (kind === 'expense' && !catHit) warnings.push('没识别到分类，已归到「其他支出」，可手动改');
  if (isSpecial) warnings.push(`${KIND_MAP[kind]?.name || kind}不计入家庭收支合计，只调整账户余额`);
  if (kind === 'transfer' && !accHit) warnings.push('没认出转出/转入账户，请手动选一下');
  if (claimHit) warnings.push('疑似垫付待报销，已标记「可报销」');
  // 光说「还钱」不知道是谁还谁：可能是别人还我（收回），也可能是我还别人（归还）。
  // 方向反了不影响合计（借还款都不计入），但债权债务会记反，所以提示核对。
  if (/^(还钱|还款|还了钱|还清)$/.test(kindHit.source || '')) {
    warnings.push('「还钱」没说是谁还谁，请核对一下方向');
  }

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
    reimbursable: claimHit,
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
