/**
 * 数据层：把「Supabase 远程」和「本机演示」两套实现收敛成同一个接口，
 * 界面层不需要知道自己跑在哪种模式。
 */

import { SupabaseClient, SupabaseError } from './supabase.js';
import { DEFAULT_ACCOUNTS, DEFAULT_CATEGORIES } from './defaults.js';
import { pad2, todayISO, shiftMonth, monthRange, round2 } from './utils.js';

/* ------------------------------------------------------------------ */
/* 公共工具                                                           */
/* ------------------------------------------------------------------ */

/** 把 defaults.js 的树结构展开成「待插入的行」 */
function categoryRowsForSeed(familyId) {
  const parents = [];
  const children = [];
  DEFAULT_CATEGORIES.forEach((parent, index) => {
    parents.push({
      family_id: familyId,
      parent_id: null,
      name: parent.name,
      kind: parent.kind,
      icon: parent.icon || null,
      keywords: parent.keywords || [],
      sort: (index + 1) * 10,
    });
    (parent.children || []).forEach((child, ci) => {
      children.push({
        family_id: familyId,
        parentKey: parent.name,
        name: child.name,
        kind: parent.kind,
        icon: null,
        keywords: child.keywords || [],
        sort: (index + 1) * 10 + (ci + 1),
      });
    });
  });
  return { parents, children };
}

function accountRowsForSeed(familyId) {
  // 注意：accounts 表没有 sort 列（顺序靠 created_at），不要往这里塞多余字段，
  // 否则 PostgREST 会以 "column sort of relation accounts does not exist" 整批拒绝。
  return DEFAULT_ACCOUNTS.map((a) => ({
    family_id: familyId,
    name: a.name,
    kind: a.kind,
    initial_balance: 0,
    archived: false,
  }));
}

/* ------------------------------------------------------------------ */
/* 远程实现（Supabase）                                                */
/* ------------------------------------------------------------------ */

export class RemoteStore {
  constructor({ url, anonKey, storage }) {
    this.mode = 'remote';
    this.client = new SupabaseClient({ url, anonKey, storage });
    this.profile = null;
    this.family = null;
    this.members = [];
    this.categories = [];
    this.accounts = [];
  }

  get session() {
    return this.client.session;
  }

  get userId() {
    return this.client.userId;
  }

  /* ---- 认证 ---- */

  async signUp(email, password, displayName) {
    await this.client.signUp(email, password, displayName);
    await this.loadProfile();
  }

  async signIn(email, password) {
    await this.client.signIn(email, password);
    await this.loadProfile();
  }

  async signOut() {
    await this.client.signOut();
    this.profile = null;
    this.family = null;
    this.members = [];
    this.categories = [];
    this.accounts = [];
  }

  /* ---- 档案与家庭 ---- */

  async loadProfile() {
    if (!this.client.session) {
      this.profile = null;
      return null;
    }
    const rows = await this.client.table('members', {
      select: '*',
      filters: { id: `eq.${this.client.userId}` },
    });
    this.profile = rows?.[0] || null;
    if (this.profile?.family_id) {
      await this.loadFamily();
    } else {
      this.family = null;
      this.members = [];
      this.categories = [];
      this.accounts = [];
    }
    return this.profile;
  }

  async loadFamily() {
    const familyId = this.profile?.family_id;
    if (!familyId) return;
    const [families, members, categories, accounts] = await Promise.all([
      this.client.table('families', { select: '*', filters: { id: `eq.${familyId}` } }),
      this.client.table('members', { select: '*', filters: { family_id: `eq.${familyId}` }, order: 'created_at.asc' }),
      this.client.table('categories', {
        select: '*',
        filters: { family_id: `eq.${familyId}`, archived: 'eq.false' },
        order: 'sort.asc',
      }),
      this.client.table('accounts', {
        select: '*',
        filters: { family_id: `eq.${familyId}`, archived: 'eq.false' },
        order: 'created_at.asc',
      }),
    ]);
    this.family = families?.[0] || null;
    this.members = members || [];
    this.categories = categories || [];
    this.accounts = accounts || [];
  }

  async createFamily(familyName, displayName, role) {
    const family = await this.client.rpc('create_family', {
      p_family_name: familyName,
      p_display_name: displayName,
      p_role: role,
    });
    const familyId = Array.isArray(family) ? family[0]?.id : family?.id;
    if (!familyId) throw new Error('创建家庭失败，请重试');
    await this._seedFamily(familyId);
    await this.loadProfile();
    return this.family;
  }

  async joinFamily(code, displayName, role) {
    const family = await this.client.rpc('join_family_by_code', {
      p_code: code,
      p_display_name: displayName,
      p_role: role,
    });
    const familyId = Array.isArray(family) ? family[0]?.id : family?.id;
    if (!familyId) throw new Error('加入失败，请检查邀请码');
    await this.loadProfile();
    return this.family;
  }

  async _seedFamily(familyId) {
    const { parents, children } = categoryRowsForSeed(familyId);
    const insertedParents = await this.client.table('categories', {
      method: 'POST',
      body: parents.map(({ ...p }) => p),
      prefer: 'return=representation',
    });
    const idByName = new Map((insertedParents || []).map((r) => [r.name, r.id]));
    const childRows = children
      .map(({ parentKey, ...row }) => ({ ...row, parent_id: idByName.get(parentKey) || null }))
      .filter((row) => row.parent_id);
    if (childRows.length) {
      await this.client.table('categories', { method: 'POST', body: childRows, prefer: 'return=minimal' });
    }
    await this.client.table('accounts', {
      method: 'POST',
      body: accountRowsForSeed(familyId),
      prefer: 'return=minimal',
    });
  }

  async updateProfile(patch) {
    await this.client.table('members', {
      method: 'PATCH',
      filters: { id: `eq.${this.client.userId}` },
      body: patch,
      prefer: 'return=representation',
    });
    await this.loadProfile();
  }

  async updateFamily(patch) {
    if (!this.family) return;
    await this.client.table('families', {
      method: 'PATCH',
      filters: { id: `eq.${this.family.id}` },
      body: patch,
      prefer: 'return=representation',
    });
    await this.loadFamily();
  }

  /* ---- 账目 ---- */

  /**
   * 取某个日期区间的账目。
   * PostgREST 的区间写法：occurred_on=gte.X 与 and=(occurred_on.lte.Y)
   */
  async fetchTransactions(from, to) {
    const filters = {};
    if (from) filters.occurred_on = `gte.${from}`;
    if (to) filters.and = `(occurred_on.lte.${to})`;
    const rows = await this.client.table('transactions', {
      select: '*',
      filters,
      order: 'occurred_on.desc,created_at.desc',
    });
    return rows || [];
  }

  async addTransaction(tx) {
    const payload = {
      family_id: this.family.id,
      created_by: this.client.userId,
      ...tx,
    };
    const rows = await this.client.table('transactions', {
      method: 'POST',
      body: payload,
      prefer: 'return=representation',
    });
    return rows?.[0] || null;
  }

  async updateTransaction(id, patch) {
    const rows = await this.client.table('transactions', {
      method: 'PATCH',
      filters: { id: `eq.${id}` },
      body: patch,
      prefer: 'return=representation',
    });
    return rows?.[0] || null;
  }

  async deleteTransaction(id) {
    await this.client.table('transactions', {
      method: 'DELETE',
      filters: { id: `eq.${id}` },
      prefer: 'return=minimal',
    });
  }

  /* ---- 分类 ---- */

  async addCategory({ name, kind, parentId = null, icon = null, keywords = [] }) {
    const rows = await this.client.table('categories', {
      method: 'POST',
      body: {
        family_id: this.family.id,
        parent_id: parentId,
        name,
        kind,
        icon,
        keywords,
        sort: 999,
      },
      prefer: 'return=representation',
    });
    await this.loadFamily();
    return rows?.[0] || null;
  }

  async deleteCategory(id) {
    await this.client.table('categories', {
      method: 'DELETE',
      filters: { id: `eq.${id}` },
      prefer: 'return=minimal',
    });
    await this.loadFamily();
  }

  /* ---- 预算 ---- */

  async listBudgets(month) {
    return (
      (await this.client.table('budgets', {
        select: '*',
        filters: { month: `eq.${month}` },
        order: 'created_at.asc',
      })) || []
    );
  }

  async saveBudget(month, categoryId, amount) {
    if (!amount || amount <= 0) {
      await this.client.table('budgets', {
        method: 'DELETE',
        filters: {
          month: `eq.${month}`,
          ...(categoryId ? { category_id: `eq.${categoryId}` } : { category_id: 'is.null' }),
        },
        prefer: 'return=minimal',
      });
      return null;
    }
    await this.client.table('budgets', {
      method: 'DELETE',
      filters: {
        month: `eq.${month}`,
        ...(categoryId ? { category_id: `eq.${categoryId}` } : { category_id: 'is.null' }),
      },
      prefer: 'return=minimal',
    });
    const rows = await this.client.table('budgets', {
      method: 'POST',
      body: { family_id: this.family.id, month, category_id: categoryId || null, amount },
      prefer: 'return=representation',
    });
    return rows?.[0] || null;
  }

  /**
   * 只有演示模式有「本机演示数据」可重置；远程模式保留这个方法是为了两种实现接口一致，
   * 界面上这个按钮也只在演示模式渲染，正常不会走到这里。
   */
  resetDemo() {
    throw new Error('远程模式没有演示数据可重置');
  }
}

/* ------------------------------------------------------------------ */
/* 本机演示实现（localStorage）                                        */
/* ------------------------------------------------------------------ */

const DEMO_KEY = 'he.demo.v1';

function demoSeed() {
  const familyId = 'demo-family';
  const { parents, children } = categoryRowsForSeed(familyId);
  const idByName = new Map();
  const categories = [];
  parents.forEach((p, i) => {
    const row = { ...p, id: `cat-${i}`, created_at: new Date().toISOString() };
    idByName.set(p.name, row.id);
    categories.push(row);
  });
  children.forEach((c, i) => {
    const parentId = idByName.get(c.parentKey);
    if (!parentId) return;
    categories.push({
      family_id: familyId,
      parent_id: parentId,
      name: c.name,
      kind: c.kind,
      icon: null,
      keywords: c.keywords,
      sort: c.sort,
      archived: false,
      id: `cat-${parents.length + i}`,
      created_at: new Date().toISOString(),
    });
  });

  const catIdByName = new Map(categories.map((c) => [c.name, c.id]));

  const members = [
    { id: 'm-dad', family_id: familyId, display_name: '爸爸', role: 'father', created_at: '2026-01-01T00:00:00Z' },
    { id: 'm-mom', family_id: familyId, display_name: '妈妈', role: 'mother', created_at: '2026-01-01T00:00:01Z' },
    { id: 'm-kid', family_id: familyId, display_name: '小明', role: 'child', created_at: '2026-01-01T00:00:02Z' },
  ];

  const accounts = accountRowsForSeed(familyId).map((a, i) => ({ ...a, id: `acc-${i}`, created_at: new Date().toISOString() }));

  const months = [shiftMonth(monthOfNow(), -2), shiftMonth(monthOfNow(), -1), monthOfNow()];
  const templates = [
    { day: 3, kind: 'expense', amount: 86.5, cat: '买菜', member: 'm-mom', note: '超市买菜' },
    { day: 5, kind: 'expense', amount: 32, cat: '在外吃饭', member: 'm-dad', note: '午饭' },
    { day: 6, kind: 'expense', amount: 218, cat: '打车', member: 'm-dad', note: '' },
    { day: 8, kind: 'expense', amount: 1200, cat: '补习培训', member: 'm-kid', note: '数学补习班' },
    { day: 10, kind: 'expense', amount: 168, cat: '话费流量', member: 'm-mom', note: '话费' },
    { day: 12, kind: 'expense', amount: 45, cat: '零食饮料', member: 'm-kid', note: '零食' },
    { day: 15, kind: 'expense', amount: 3200, cat: '房租房贷', member: 'm-dad', note: '房贷' },
    { day: 18, kind: 'expense', amount: 260, cat: '水电燃气', member: 'm-mom', note: '电费水费' },
    { day: 20, kind: 'expense', amount: 399, cat: '服饰鞋帽', member: 'm-mom', note: '外套' },
    { day: 22, kind: 'expense', amount: 120, cat: '药品', member: 'm-kid', note: '感冒药' },
    { day: 25, kind: 'income', amount: 12000, cat: '工资薪金', member: 'm-dad', note: '月工资' },
    { day: 25, kind: 'income', amount: 8000, cat: '工资薪金', member: 'm-mom', note: '月工资' },
    { day: 28, kind: 'income', amount: 2000, cat: '奖金提成', member: 'm-dad', note: '季度奖金' },
    { day: 28, kind: 'transfer', amount: 3000, cat: null, member: 'm-dad', note: '银行卡转微信' },
  ];

  const transactions = [];
  let seq = 0;
  for (const month of months) {
    const [y, m] = month.split('-').map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    for (const t of templates) {
      const day = Math.min(t.day, lastDay);
      seq += 1;
      transactions.push({
        id: `tx-${seq}`,
        family_id: familyId,
        kind: t.kind,
        amount: t.amount,
        occurred_on: `${month}-${pad2(day)}`,
        category_id: t.cat ? catIdByName.get(t.cat) || null : null,
        member_id: t.member,
        account_id: null,
        to_account_id: null,
        note: t.note,
        raw_input: '',
        reimbursable: false,
        reimburse_of: null,
        created_by: t.member,
        created_at: `${month}-${pad2(day)}T10:00:00Z`,
        updated_at: `${month}-${pad2(day)}T10:00:00Z`,
      });
    }
  }

  return {
    session: { user: { id: 'demo-user', email: 'demo@local' } },
    profile: { id: 'm-dad', family_id: familyId, display_name: '爸爸', role: 'father' },
    family: { id: familyId, name: '演示家庭', invite_code: 'DEMO01', created_by: 'demo-user' },
    members,
    categories,
    accounts,
    transactions,
    budgets: [],
  };
}

function monthOfNow() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

export class DemoStore {
  constructor(storage) {
    this.mode = 'demo';
    this.storage = storage || globalThis.localStorage;
    const saved = this._load();
    if (saved) {
      this.db = saved;
    } else {
      this.db = demoSeed();
      this._save();
    }
  }

  _load() {
    try {
      const raw = this.storage.getItem(DEMO_KEY);
      if (raw && raw !== 'undefined') return JSON.parse(raw);
    } catch {
      /* ignore */
    }
    return null;
  }

  _save() {
    try {
      this.storage.setItem(DEMO_KEY, JSON.stringify(this.db));
    } catch {
      /* ignore */
    }
  }

  resetDemo() {
    this.db = demoSeed();
    this._save();
  }

  get session() {
    return this.db.session;
  }

  get userId() {
    return this.db.session?.user?.id || null;
  }

  get profile() {
    return this.db.profile;
  }

  get family() {
    return this.db.family;
  }

  get members() {
    return this.db.members;
  }

  get categories() {
    return this.db.categories;
  }

  get accounts() {
    return this.db.accounts;
  }

  async signUp() {
    throw new SupabaseError('演示模式不需要注册，直接使用即可');
  }

  async signIn() {
    throw new SupabaseError('演示模式不需要登录，直接使用即可');
  }

  async signOut() {
    this.resetDemo();
  }

  async loadProfile() {
    return this.db.profile;
  }

  async loadFamily() {
    return this.db.family;
  }

  async createFamily() {
    throw new SupabaseError('演示模式已有一个家庭，配置 Supabase 后可以创建真实家庭');
  }

  async joinFamily() {
    throw new SupabaseError('演示模式不能加入家庭，配置 Supabase 后可用邀请码加入');
  }

  async updateProfile(patch) {
    Object.assign(this.db.profile, patch);
    const me = this.db.members.find((m) => m.id === this.db.profile.id);
    if (me) Object.assign(me, patch);
    this._save();
  }

  async updateFamily(patch) {
    Object.assign(this.db.family, patch);
    this._save();
  }

  async fetchTransactions(from, to) {
    return this.db.transactions
      .filter((t) => (!from || t.occurred_on >= from) && (!to || t.occurred_on <= to))
      .sort((a, b) => (a.occurred_on < b.occurred_on ? 1 : a.occurred_on > b.occurred_on ? -1 : 0));
  }

  async addTransaction(tx) {
    const row = {
      id: `tx-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      family_id: this.db.family.id,
      created_by: this.userId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      reimbursable: false,
      reimburse_of: null,
      ...tx,
    };
    this.db.transactions.push(row);
    this._save();
    return row;
  }

  async updateTransaction(id, patch) {
    const row = this.db.transactions.find((t) => t.id === id);
    if (row) {
      Object.assign(row, patch, { updated_at: new Date().toISOString() });
      this._save();
    }
    return row || null;
  }

  async deleteTransaction(id) {
    this.db.transactions = this.db.transactions.filter((t) => t.id !== id);
    this._save();
  }

  async addCategory({ name, kind, parentId = null, icon = null, keywords = [] }) {
    const row = {
      id: `cat-${Date.now()}`,
      family_id: this.db.family.id,
      parent_id: parentId,
      name,
      kind,
      icon,
      keywords,
      sort: 999,
      archived: false,
      created_at: new Date().toISOString(),
    };
    this.db.categories.push(row);
    this._save();
    return row;
  }

  async deleteCategory(id) {
    this.db.categories = this.db.categories.filter((c) => c.id !== id && c.parent_id !== id);
    this._save();
  }

  async listBudgets(month) {
    return this.db.budgets.filter((b) => b.month === month);
  }

  async saveBudget(month, categoryId, amount) {
    this.db.budgets = this.db.budgets.filter(
      (b) => !(b.month === month && (b.category_id || null) === (categoryId || null)),
    );
    if (amount && amount > 0) {
      this.db.budgets.push({
        id: `bd-${Date.now()}`,
        family_id: this.db.family.id,
        month,
        category_id: categoryId || null,
        amount: round2(amount),
      });
    }
    this._save();
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 工厂                                                               */
/* ------------------------------------------------------------------ */

export function createStore(config, storage) {
  if (config.supabaseUrl && config.supabaseAnonKey) {
    return new RemoteStore({ url: config.supabaseUrl, anonKey: config.supabaseAnonKey, storage });
  }
  return new DemoStore(storage);
}

export { categoryRowsForSeed, accountRowsForSeed };
