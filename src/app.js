/**
 * 界面层：单页应用，四个标签页 —— 记账 / 流水 / 统计 / 我的
 * 无框架、无构建步骤，改完刷新即可生效。
 */

import { CONFIG, isConfigured } from './config.js';
import { createStore } from './store.js';
import { KINDS, KIND_MAP, ROLES } from './defaults.js';
import { parseEntry } from './parse.js';
import * as A from './analytics.js';
import { donutChart, legend, groupedBars, horizontalBars } from './charts.js';
import { buildXlsx } from './xlsx.js';
import * as U from './utils.js';

const ROLE_MAP = Object.fromEntries(ROLES.map((r) => [r.key, r.name]));

const TABS = [
  { key: 'record', name: '记账', icon: '✏️' },
  { key: 'list', name: '流水', icon: '📋' },
  { key: 'stats', name: '统计', icon: '📊' },
  { key: 'me', name: '我的', icon: '👤' },
];

/**
 * 这台设备上「网页语音识别」能不能用。
 *
 * iPhone / iPad 上不管装的是 Chrome、Edge 还是微信，内里都是 Safari 的内核（WebKit），
 * 网页语音识别一律不可用——所以对 iOS 用户说「换个浏览器」是句照做也没用的话。
 * 那里唯一能用的办法是系统键盘自带的听写（键盘右下角那个 🎤），说出来的字会直接进输入框，
 * 后面的识别流程完全一样。判断要是不准，给出的建议就没法照做，比不给建议更糟。
 */
function voiceEnv() {
  if (globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition) return 'ok';
  const nav = globalThis.navigator || {};
  const ua = String(nav.userAgent || '');
  const iPadAsMac = /Macintosh/i.test(ua) && Number(nav.maxTouchPoints || 0) > 1;
  return /iPhone|iPad|iPod/i.test(ua) || iPadAsMac ? 'ios' : 'none';
}

const VOICE_HINT = {
  ios: 'iPhone / iPad 上网页用不了浏览器语音。点上面的输入框，用键盘右下角的 🎤 说话，说完点「识别一下」，效果一样。',
  none: '这个浏览器不支持网页语音。点输入框用键盘上的语音键，或者换 Chrome / Edge，也可以直接打字。',
};

/* ------------------------------------------------------------------ */

class App {
  constructor(root, store) {
    this.root = root;
    this.store = store;
    this.tab = 'record';
    this.month = U.currentMonth();
    this.cache = new Map();
    this.rawText = '';
    this.draft = null;
    this.editing = null;
    this.toastMsg = '';
    this.toastTimer = null;
    this.busy = false;
    this.authError = '';
    this.authMode = 'signin'; // signin | signup
    this.familyMode = 'create'; // create | join
    this.listenState = null;
    this.budgetMonth = U.currentMonth();
    this.budgets = [];
    this.monthBudgets = [];
    this.showCategoryManager = false;
    this._onRootClick = this._onRootClick.bind(this);
    this._onRootInput = this._onRootInput.bind(this);
    this._onRootChange = this._onRootChange.bind(this);
    this._bound = false;
  }

  /* ---------------- 生命周期 ---------------- */

  async init() {
    this._bind();
    try {
      if (this.store.mode === 'remote') {
        await this.store.loadProfile();
      } else {
        await this.store.loadProfile();
      }
    } catch (err) {
      this.authError = this._friendly(err);
    }
    await this.refreshData();
    this.render();
  }

  _bind() {
    if (this._bound) return;
    this.root.addEventListener('click', this._onRootClick);
    this.root.addEventListener('input', this._onRootInput);
    this.root.addEventListener('change', this._onRootChange);
    // 手机切回前台时重新拉一次数据。一家人共用一本账，切回来看到的必须是最新的，
    // 否则会出现「我在自己手机上记了，你那边还是老数字」。顺便也会触发登录续期。
    const doc = globalThis.document;
    if (doc && typeof doc.addEventListener === 'function') {
      this._onVisibilityChange = () => {
        if (doc.visibilityState === 'hidden') return undefined;
        return this.refreshAndRender(); // 返回 promise 方便测试等待（事件监听器会忽略返回值）
      };
      doc.addEventListener('visibilitychange', this._onVisibilityChange);
    }
    this._bound = true;
  }

  /** 重新拉数据并重绘（切回前台、手动刷新都用这个） */
  async refreshAndRender() {
    if (!this.loggedIn || !this.hasFamily) return this.render();
    await this.refreshData();
    return this.render();
  }

  get loggedIn() {
    return Boolean(this.store.session);
  }

  get hasFamily() {
    return Boolean(this.store.profile?.family_id);
  }

  get isDemo() {
    return this.store.mode === 'demo';
  }

  /* ---------------- 数据 ---------------- */

  async refreshData() {
    if (!this.loggedIn || !this.hasFamily) return;
    const months = [this.month, this.budgetMonth, U.currentMonth()];
    for (let i = 1; i <= 5; i += 1) months.push(U.shiftMonth(this.month, -i));
    const from = U.monthRange(months.reduce((a, b) => (a < b ? a : b))).from;
    const to = U.monthRange(months.reduce((a, b) => (a > b ? a : b))).to;
    try {
      const rows = await this.store.fetchTransactions(from, to);
      for (const row of rows) this.cache.set(row.id, row);
      this.budgets = await this.store.listBudgets(this.budgetMonth);
      this.monthBudgets = this.budgetMonth === this.month
        ? this.budgets
        : await this.store.listBudgets(this.month);
    } catch (err) {
      this.showToast(this._friendly(err));
    }
  }

  txOfMonth(month) {
    return [...this.cache.values()].filter((t) => String(t.occurred_on).slice(0, 7) === month);
  }

  txInRange(from, to) {
    return [...this.cache.values()].filter((t) => t.occurred_on >= from && t.occurred_on <= to);
  }

  /** 账户余额要看全部历史，单独拉一次并记住已拉过 */
  async ensureFullHistory() {
    if (this.fullLoaded || !this.hasFamily) return;
    try {
      const rows = await this.store.fetchTransactions('2000-01-01', U.todayISO());
      for (const row of rows) this.cache.set(row.id, row);
      this.fullLoaded = true;
    } catch (err) {
      this.showToast(this._friendly(err));
    }
  }

  get categories() {
    return this.store.categories || [];
  }

  get members() {
    return this.store.members || [];
  }

  get myMember() {
    return this.members.find((m) => m.id === this.store.profile?.id) || this.members[0] || null;
  }

  categoryById(id) {
    return A.categoryMap(this.categories).get(id) || null;
  }

  memberName(id) {
    const m = this.members.find((x) => x.id === id);
    return m ? m.display_name : '';
  }

  /* ---------------- 事件 ---------------- */

  _onRootInput(e) {
    const el = e.target;
    if (!el?.dataset) return;
    if (el.dataset.bind === 'rawText') {
      this.rawText = el.value;
    } else if (el.dataset.bind === 'draft') {
      if (!this.draft) return;
      const field = el.dataset.field;
      if (field === 'note') this.draft.note = el.value;
      else if (field === 'amount') this.draft.amount = el.value === '' ? null : Number(el.value);
      else if (field === 'occurredOn') this.draft.occurredOn = el.value;
    }
  }

  _onRootChange(e) {
    const el = e.target;
    if (!el?.dataset) return;
    if (el.dataset.bind !== 'draft' || !this.draft) return;
    const field = el.dataset.field;
    if (field === 'kind') {
      this.draft.kind = el.value;
      const meta = KIND_MAP[el.value];
      // 报销回款要看得到分类（它冲减的是那笔垫付的分类），其他特殊类型不要分类
      if (meta?.counted === false && el.value !== 'reimburse_back') this.draft.categoryId = null;
      if (meta?.counted !== false && !this.draft.categoryId) {
        const first = this.categories.find((c) => c.kind === (el.value === 'income' ? 'income' : 'expense'));
        this.draft.categoryId = first?.id || null;
      }
      this.render();
    } else if (field === 'categoryId') {
      this.draft.categoryId = el.value || null;
    } else if (field === 'reimburseOf') {
      this.draft.reimburseOf = el.value || null;
      const origin = el.value ? this.cache.get(el.value) : null;
      if (origin?.category_id) this.draft.categoryId = origin.category_id;
      if (origin?.member_id) this.draft.memberId = origin.member_id;
      this.render();
    } else if (field === 'memberId') {
      this.draft.memberId = el.value || null;
    } else if (field === 'accountId') {
      this.draft.accountId = el.value || null;
    } else if (field === 'toAccountId') {
      this.draft.toAccountId = el.value || null;
    }
  }

  async _onRootClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    try {
      await this._handleAction(act, btn, e);
    } catch (err) {
      this.showToast(this._friendly(err));
    }
  }

  async _handleAction(act, btn, e) {
    switch (act) {
      /* 认证 */
      case 'switch-auth':
        this.authMode = this.authMode === 'signin' ? 'signup' : 'signin';
        this.authError = '';
        return this.render();
      case 'submit-auth':
        return this.submitAuth();
      case 'submit-family':
        return this.submitFamily();
      case 'switch-family-mode':
        this.familyMode = this.familyMode === 'create' ? 'join' : 'create';
        return this.render();
      case 'signout':
        await this.store.signOut();
        this.cache.clear();
        this.render();
        return;

      /* 导航 */
      case 'tab': {
        this.tab = btn.dataset.tab;
        if (this.tab === 'stats' || this.tab === 'list') await this.refreshData();
        if (this.tab === 'me') await this.ensureFullHistory();
        return this.render();
      }
      case 'month-prev':
      case 'month-next': {
        this.month = U.shiftMonth(this.month, act === 'month-prev' ? -1 : 1);
        await this.refreshData();
        return this.render();
      }

      /* 记账 */
      case 'parse':
        return this.doParse(this.rawText);
      case 'voice':
        return this.startVoice();
      case 'clear-text':
        this.rawText = '';
        this.draft = null;
        return this.render();
      case 'cancel-draft':
      case 'cancel-edit':
        this.draft = null;
        this.editing = null;
        this.rawText = '';
        return this.render();
      case 'save-draft':
        return this.saveDraft();
      case 'edit-tx': {
        const id = btn.dataset.id;
        const tx = this.cache.get(id);
        if (!tx) return;
        this.editing = id;
        this.draft = {
          kind: tx.kind,
          amount: Number(tx.amount),
          occurredOn: tx.occurred_on,
          categoryId: tx.category_id,
          memberId: tx.member_id,
          note: tx.note || '',
          reimbursable: tx.reimbursable,
          accountId: tx.account_id,
          toAccountId: tx.to_account_id,
          reimburseOf: tx.reimburse_of,
          raw: tx.raw_input || '',
          warnings: [],
          confidence: 1,
          fromEdit: true,
        };
        this.tab = 'record';
        return this.render();
      }
      case 'delete-tx': {
        const id = btn.dataset.id;
        if (!confirm('确定删除这条账目吗？')) return;
        await this.store.deleteTransaction(id);
        this.cache.delete(id);
        await this.refreshData();
        this.showToast('已删除');
        return this.render();
      }
      case 'delete-draft':
        if (!this.editing) return;
        if (!confirm('确定删除这条账目吗？')) return;
        await this.store.deleteTransaction(this.editing);
        this.cache.delete(this.editing);
        this.editing = null;
        this.draft = null;
        await this.refreshData();
        this.showToast('已删除');
        return this.render();

      /* 我的 */
      case 'copy-invite':
        return this.copyInvite();
      case 'save-profile':
        return this.saveProfile();
      case 'toggle-cat-manager':
        this.showCategoryManager = !this.showCategoryManager;
        return this.render();
      case 'add-category':
        return this.addCategory();
      case 'delete-category':
        if (!confirm('删除这个分类？已有账目会变成未分类。')) return;
        await this.store.deleteCategory(btn.dataset.id);
        return this.render();
      case 'budget-month-prev':
      case 'budget-month-next':
        this.budgetMonth = U.shiftMonth(this.budgetMonth, act === 'budget-month-prev' ? -1 : 1);
        this.budgets = await this.store.listBudgets(this.budgetMonth);
        return this.render();
      case 'save-budget':
        return this.saveBudget();
      case 'export-csv':
        return this.exportCsv();
      case 'export-xlsx':
        return this.exportXlsx();
      case 'reset-demo':
        if (!confirm('重置演示数据？本机改动会全部丢掉。')) return;
        this.store.resetDemo();
        this.cache.clear();
        await this.refreshData();
        return this.render();
      default:
        return undefined;
    }
  }

  /* ---------------- 认证 ---------------- */

  async submitAuth() {
    if (this.busy) return; // 防重复提交：连点两下注册会发出两次请求
    const email = this.root.querySelector('#auth-email')?.value.trim();
    const password = this.root.querySelector('#auth-password')?.value || '';
    const name = this.root.querySelector('#auth-name')?.value.trim();
    if (!email || !password) {
      this.authError = '邮箱和密码都要填';
      return this.render();
    }
    if (this.authMode === 'signup' && password.length < 6) {
      this.authError = '密码至少 6 位';
      return this.render();
    }
    this.busy = true;
    this.authError = '';
    this.render();
    try {
      if (this.authMode === 'signup') await this.store.signUp(email, password, name || '我');
      else await this.store.signIn(email, password);
      await this.refreshData();
    } catch (err) {
      this.authError = this._friendly(err);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  async submitFamily() {
    if (this.busy) return; // 防重复提交：连点两下会建出两个家庭
    const familyName = this.root.querySelector('#family-name')?.value.trim() || '我的家';
    const code = this.root.querySelector('#family-code')?.value.trim() || '';
    const displayName = this.root.querySelector('#family-display')?.value.trim() || '我';
    const role = this.root.querySelector('#family-role')?.value || 'father';
    this.busy = true;
    this.authError = '';
    this.render();
    try {
      if (this.familyMode === 'create') await this.store.createFamily(familyName, displayName, role);
      else await this.store.joinFamily(code, displayName, role);
      await this.refreshData();
    } catch (err) {
      this.authError = this._friendly(err);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  async saveProfile() {
    const displayName = this.root.querySelector('#profile-name')?.value.trim();
    const role = this.root.querySelector('#profile-role')?.value || 'father';
    if (!displayName) return this.showToast('昵称不能为空');
    await this.store.updateProfile({ display_name: displayName, role });
    this.showToast('已保存');
    return this.render();
  }

  async copyInvite() {
    const code = this.store.family?.invite_code;
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      this.showToast(`邀请码 ${code} 已复制`);
    } catch {
      this.showToast(`邀请码：${code}`);
    }
    return undefined;
  }

  /* ---------------- 记账 ---------------- */

  async doParse(text) {
    if (!text || !text.trim()) return this.showToast('先说一句或写一句，比如「今天买菜35元」');
    const draft = parseEntry(text, {
      today: U.todayISO(),
      members: this.members,
      accounts: this.store.accounts || [],
      categories: this.categories.map((c) => {
        const full = this.categoryById(c.id);
        return { ...c, parentName: full?.parentName || null, fullName: full?.fullName || c.name };
      }),
    });
    draft.accountId = draft.fromAccountId || null;
    // 默认人员：当前登录人
    if (!draft.memberId && this.myMember) {
      draft.memberId = this.myMember.id;
      draft.memberName = this.myMember.display_name;
    }
    // 特殊类型不挂分类
    if (KIND_MAP[draft.kind] && !KIND_MAP[draft.kind].counted) draft.categoryId = null;
    if (!draft.categoryId && draft.kind !== 'transfer') {
      const wanted = draft.kind === 'income' ? 'income' : 'expense';
      const fallback = this.categories.find(
        (c) => c.kind === wanted && /其他/.test(c.name),
      ) || this.categories.find((c) => c.kind === wanted);
      if (fallback) {
        draft.categoryId = fallback.id;
        draft.categoryName = fallback.name;
      }
    }
    this.draft = draft;
    this.editing = null;
    return this.render();
  }

  async saveDraft() {
    if (this.busy) return; // 防重复提交：双击或手抖点两下，不能记成两笔
    const d = this.draft;
    if (!d) return;
    if (d.amount == null || Number(d.amount) <= 0) return this.showToast('金额要大于 0');
    if (!d.occurredOn) return this.showToast('请选择日期');
    if (d.kind === 'transfer') {
      if (!d.accountId || !d.toAccountId) return this.showToast('转账要选好转出和转入账户');
      if (d.accountId === d.toAccountId) return this.showToast('转出和转入不能是同一个账户');
    }
    const kindMeta = KIND_MAP[d.kind];
    const payload = {
      kind: d.kind,
      amount: U.round2(Number(d.amount)),
      occurred_on: d.occurredOn,
      category_id: kindMeta?.counted === false && d.kind !== 'reimburse_back' ? null : d.categoryId || null,
      member_id: d.memberId || null,
      note: d.note || '',
      raw_input: d.raw || this.rawText || '',
      reimbursable: Boolean(d.reimbursable),
      account_id: d.accountId || null,
      to_account_id: d.toAccountId || null,
      reimburse_of: d.reimburseOf || null,
    };
    this.busy = true;
    this.render();
    try {
      if (this.editing) await this.store.updateTransaction(this.editing, payload);
      else await this.store.addTransaction(payload);
      this.draft = null;
      this.editing = null;
      this.rawText = '';
      // 补录到别的月份时，把视图切到那个月。
      // 否则用户记完去「流水」一看没有，会以为没记上（其实记在上个月，只是当前看的是这个月）。
      const savedMonth = String(payload.occurred_on).slice(0, 7);
      const moved = savedMonth !== this.month;
      if (moved) this.month = savedMonth;
      await this.refreshData();
      this.showToast(moved ? `记好了，记在 ${savedMonth}` : '记好了');
    } catch (err) {
      this.showToast(this._friendly(err));
    } finally {
      this.busy = false;
      this.render();
    }
  }

  startVoice() {
    const env = voiceEnv();
    if (env !== 'ok') {
      this.showToast(env === 'ios' ? 'iPhone 上请点输入框，用键盘上的 🎤 说话' : '这个浏览器不支持网页语音，用键盘的语音键或直接打字');
      // 顺手把输入框聚焦，等于替用户把键盘（连着听写键）调出来
      const ta = this.root.querySelector('#raw-text');
      if (ta && typeof ta.focus === 'function') ta.focus();
      return undefined;
    }
    const SR = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
    if (this.listenState === 'listening') return undefined;
    try {
      const rec = new SR();
      rec.lang = 'zh-CN';
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      rec.continuous = false;
      this.recognizer = rec;
      rec.onstart = () => {
        this.listenState = 'listening';
        this.render();
      };
      rec.onerror = (ev) => {
        this.listenState = null;
        this.showToast(ev.error === 'not-allowed' ? '麦克风被拒绝了，请在浏览器里允许' : `语音识别出错：${ev.error}`);
        this.render();
      };
      rec.onend = () => {
        this.listenState = null;
        this.render();
      };
      rec.onresult = (ev) => {
        let text = '';
        for (let i = 0; i < ev.results.length; i += 1) text += ev.results[i][0].transcript;
        this.rawText = text.trim();
        const ta = this.root.querySelector('#raw-text');
        if (ta) ta.value = this.rawText;
        if (ev.results[0].isFinal) {
          this.doParse(this.rawText);
        }
      };
      rec.start();
      this.showToast('请说话…');
    } catch (err) {
      this.showToast(`无法启动语音：${err.message}`);
    }
    return undefined;
  }

  /* ---------------- 预算 / 分类 ---------------- */

  async saveBudget() {
    const rows = [...this.root.querySelectorAll('[data-budget-input]')];
    for (const input of rows) {
      const categoryId = input.dataset.budgetInput || null;
      const value = input.value.trim() === '' ? 0 : Number(input.value);
      await this.store.saveBudget(this.budgetMonth, categoryId || null, value);
    }
    this.budgets = await this.store.listBudgets(this.budgetMonth);
    this.showToast('预算已保存');
    return this.render();
  }

  async addCategory() {
    const name = this.root.querySelector('#new-cat-name')?.value.trim();
    const kind = this.root.querySelector('#new-cat-kind')?.value || 'expense';
    const parentId = this.root.querySelector('#new-cat-parent')?.value || null;
    const keywordsRaw = this.root.querySelector('#new-cat-words')?.value.trim() || '';
    if (!name) return this.showToast('分类名不能为空');
    const keywords = keywordsRaw
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    await this.store.addCategory({ name, kind, parentId, keywords });
    this.showToast('已添加');
    return this.render();
  }

  /* ---------------- 导出 ---------------- */

  /** 导出用的行数据（明细表），CSV 和 xlsx 共用，避免两边格式跑偏 */
  exportRows(month) {
    const source = this.txOfMonth(month).sort((a, b) => (a.occurred_on < b.occurred_on ? -1 : 1));
    if (!source.length) return null;
    const cmap = A.categoryMap(this.categories);
    const header = ['日期', '类型', '金额', '分类', '人员', '备注', '记账人', '可报销', '原始输入'];
    const rows = source.map((tx) => {
      const cat = tx.category_id ? cmap.get(tx.category_id) : null;
      return [
        tx.occurred_on,
        KIND_MAP[tx.kind]?.name || tx.kind,
        Number(tx.amount),
        cat ? cat.fullName : '',
        this.memberName(tx.member_id),
        tx.note || '',
        this.memberName(tx.created_by),
        tx.reimbursable ? '是' : '',
        tx.raw_input || '',
      ];
    });
    return { source, header, rows };
  }

  download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  exportCsv() {
    const month = this.month;
    const data = this.exportRows(month);
    if (!data) return this.showToast('这个月没有账目可导出');
    const lines = [data.header.map((c) => `"${c}"`).join(',')];
    for (const row of data.rows) {
      const cells = row.map((c) => `"${String(typeof c === 'number' ? c.toFixed(2) : c).replace(/"/g, '""')}"`);
      lines.push(cells.join(','));
    }
    // 加 BOM，Excel 打开中文不乱码
    this.download(
      new Blob([`\uFEFF${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8;' }),
      `家庭记账-${month}.csv`,
    );
    return undefined;
  }

  exportXlsx() {
    const month = this.month;
    const data = this.exportRows(month);
    if (!data) return this.showToast('这个月没有账目可导出');

    // 第二个工作表：按分类汇总（口径和统计页一致——特殊类型不计入收支）
    const toRows = (list, label) => list.map((c) => [c.fullName || c.name, label, c.total]);
    const summary = [
      ['分类', '收支', '金额'],
      ...toRows(A.byCategory(data.source, this.categories, 'expense'), '支出'),
      ...toRows(A.byCategory(data.source, this.categories, 'income'), '收入'),
    ];
    const totals = A.totals(data.source);
    summary.push(['合计', '支出', totals.expense], ['合计', '收入', totals.income]);

    const bytes = buildXlsx([
      { name: `${month} 明细`, rows: [data.header, ...data.rows] },
      { name: '分类汇总', rows: summary },
    ]);
    this.download(
      new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      `家庭记账-${month}.xlsx`,
    );
    return undefined;
  }

  /* ---------------- 提示 ---------------- */

  showToast(msg) {
    this.toastMsg = msg;
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toastMsg = '';
      const el = this.root.querySelector('#toast');
      if (el) {
        el.textContent = '';
        el.classList.remove('show');
      }
    }, 2600);
    const el = this.root.querySelector('#toast');
    if (el) {
      el.textContent = msg;
      el.classList.add('show');
    } else {
      this.render();
    }
  }

  _friendly(err) {
    const raw = err?.message || String(err);
    // store.js / supabase.js 已经把网络类错误换成人话了，直接用它那句，别再翻一遍
    if (err?.code === 'network' || err?.code === 'timeout') return raw;
    if (/Invalid login credentials/i.test(raw)) return '邮箱或密码不对';
    if (/User already registered/i.test(raw)) return '这个邮箱已经注册过了，直接登录吧';
    if (/email.*not.*confirmed/i.test(raw)) return '邮箱还没确认，请先点邮件里的链接（或在 Supabase 关掉「Confirm email」）';
    if (/Failed to fetch|NetworkError|Load failed/i.test(raw)) return '网络连不上 Supabase，检查一下地址/网络';
    if (/JWT|token is expired/i.test(raw)) return '登录过期了，请重新登录';
    // 下面这几条都是「数据库还没按要求建好」的不同表现，说明要明确到能照着做
    if (/Could not find the table|relation .* does not exist|PGRST205/i.test(raw)) {
      return '数据库表还没建：去 Supabase 的 SQL Editor 运行 supabase/schema.sql';
    }
    if (/Could not find the function|PGRST202/i.test(raw)) {
      return '数据库函数缺失：schema.sql 没跑完整，请整段重新运行一次';
    }
    if (/permission denied|row-level security|42501/i.test(raw)) {
      return '权限不足：多半是 schema.sql 跑了一半，整段重新运行一次';
    }
    if (/rate limit|too many requests|429/i.test(raw)) return '请求太频繁了，等半分钟再试';
    if (/Signups not allowed|signup.*(disabled|not allowed)/i.test(raw)) {
      return 'Supabase 里把注册关掉了，去 Authentication → Sign In / Providers 打开';
    }
    if (/Password should be at least|password.*(short|6 characters)/i.test(raw)) return '密码太短了，至少 6 位';
    return raw;
  }

  /* ================================================================ */
  /* 渲染                                                              */
  /* ================================================================ */

  render() {
    let body;
    if (!this.loggedIn) body = this.viewAuth();
    else if (!this.hasFamily) body = this.viewFamilySetup();
    else body = this.viewShell();

    this.root.innerHTML = `
      <div class="app-frame">
        ${body}
        <div id="toast" class="toast ${this.toastMsg ? 'show' : ''}">${U.escapeHtml(this.toastMsg)}</div>
      </div>`;
  }

  /* ---- 登录 / 注册 ---- */

  viewAuth() {
    const isSignup = this.authMode === 'signup';
    return `
    <div class="screen center">
      <div class="brand">
        <div class="brand-icon">🏠</div>
        <h1>${U.escapeHtml(CONFIG.appName)}</h1>
        <p class="muted">一家人的账，记在一起</p>
      </div>
      <div class="card">
        <div class="seg">
          <button class="seg-item ${isSignup ? '' : 'active'}" data-act="switch-auth">登录</button>
          <button class="seg-item ${isSignup ? 'active' : ''}" data-act="switch-auth">注册</button>
        </div>
        ${isSignup ? `
          <label class="field"><span>你的称呼</span>
            <input id="auth-name" type="text" placeholder="比如：爸爸" autocomplete="nickname">
          </label>` : ''}
        <label class="field"><span>邮箱</span>
          <input id="auth-email" type="email" placeholder="you@example.com" autocomplete="email">
        </label>
        <label class="field"><span>密码</span>
          <input id="auth-password" type="password" placeholder="至少 6 位" autocomplete="${isSignup ? 'new-password' : 'current-password'}">
        </label>
        ${this.authError ? `<p class="error">${U.escapeHtml(this.authError)}</p>` : ''}
        <button class="btn primary block" data-act="submit-auth" ${this.busy ? 'disabled' : ''}>
          ${this.busy ? '处理中…' : isSignup ? '注册并继续' : '登录'}
        </button>
      </div>
      <p class="fineprint">同一个家庭的人各注册一个账号，然后输邀请码加入同一本账。</p>
    </div>`;
  }

  /* ---- 建家 / 加家 ---- */

  viewFamilySetup() {
    const isCreate = this.familyMode === 'create';
    return `
    <div class="screen center">
      <div class="brand">
        <div class="brand-icon">👨‍👩‍👧</div>
        <h1>${isCreate ? '建一本家庭账' : '加入家人的账本'}</h1>
        <p class="muted">${isCreate ? '建好后会得到一个邀请码，家人用它加入' : '向家人要那个 6 位邀请码'}</p>
      </div>
      <div class="card">
        <div class="seg">
          <button class="seg-item ${isCreate ? 'active' : ''}" data-act="switch-family-mode">创建家庭</button>
          <button class="seg-item ${isCreate ? '' : 'active'}" data-act="switch-family-mode">邀请码加入</button>
        </div>
        ${isCreate ? `
          <label class="field"><span>家庭名称</span>
            <input id="family-name" type="text" placeholder="我的家">
          </label>` : `
          <label class="field"><span>邀请码</span>
            <input id="family-code" type="text" placeholder="例如 K3M9QP" style="text-transform:uppercase">
          </label>`}
        <label class="field"><span>你在家里的称呼</span>
          <input id="family-display" type="text" placeholder="比如：妈妈">
        </label>
        <label class="field"><span>你的身份</span>
          <select id="family-role">
            ${ROLES.map((r) => `<option value="${r.key}">${r.name}</option>`).join('')}
          </select>
        </label>
        ${this.authError ? `<p class="error">${U.escapeHtml(this.authError)}</p>` : ''}
        <button class="btn primary block" data-act="submit-family" ${this.busy ? 'disabled' : ''}>
          ${this.busy ? '处理中…' : isCreate ? '创建' : '加入'}
        </button>
      </div>
    </div>`;
  }

  /* ---- 主框架 ---- */

  viewShell() {
    const view = this.tab === 'record' ? this.viewRecord()
      : this.tab === 'list' ? this.viewList()
        : this.tab === 'stats' ? this.viewStats()
          : this.viewMe();
    const warning = A.budgetStatus(this.budgets, this.txOfMonth(U.currentMonth()), this.categories)
      .filter((b) => b.state !== 'ok');
    return `
    <header class="topbar">
      <div class="topbar-title">
        <strong>${U.escapeHtml(this.store.family?.name || '家庭账本')}</strong>
        ${this.isDemo ? '<span class="pill demo">演示模式</span>' : ''}
      </div>
      ${warning.length ? `<button class="pill warn" data-act="tab" data-tab="stats">⚠️ ${U.escapeHtml(warning[0].name)}${warning[0].state === 'over' ? '已超支' : '快超支'}</button>` : '<span class="pill">本月</span>'}
    </header>
    <main class="view" id="view">${view}</main>
    <nav class="tabbar">
      ${TABS.map((t) => `
        <button class="tab ${this.tab === t.key ? 'active' : ''}" data-act="tab" data-tab="${t.key}">
          <span class="tab-icon">${t.icon}</span><span class="tab-name">${t.name}</span>
        </button>`).join('')}
    </nav>`;
  }

  /* ---- 记账页 ---- */

  viewRecord() {
    const month = U.currentMonth();
    const t = A.totals(this.txOfMonth(month));
    const isEditing = Boolean(this.editing);
    return `
    <section class="card">
      <div class="month-summary">
        <div><span class="lbl">本月支出</span><strong class="exp">${U.money(t.expense)}</strong></div>
        <div><span class="lbl">本月收入</span><strong class="inc">${U.money(t.income)}</strong></div>
        <div><span class="lbl">结余</span><strong class="${t.net >= 0 ? 'inc' : 'exp'}">${U.money(t.net)}</strong></div>
      </div>
    </section>

    <section class="card">
      <div class="row-between">
        <h2>${isEditing ? '修改这笔账' : '记一笔'}</h2>
        ${isEditing ? '<span class="pill">编辑中</span>' : ''}
      </div>
      ${isEditing ? '' : `
      <div class="input-wrap">
        <textarea id="raw-text" data-bind="rawText" rows="2"
          placeholder="说一句或写一句，比如：&#10;今天给孩子报补习班花了3000&#10;11月8日买菜35.5元&#10;收到工资8000">${U.escapeHtml(this.rawText)}</textarea>
        <button class="mic ${this.listenState === 'listening' ? 'listening' : ''}" data-act="voice" title="语音输入">
          ${this.listenState === 'listening' ? '●' : '🎤'}
        </button>
      </div>
      <div class="row-gap">
        <button class="btn primary" data-act="parse">识别一下</button>
        <button class="btn ghost" data-act="clear-text">清空</button>
      </div>
      ${voiceEnv() === 'ok' ? '' : `<p class="fineprint">${U.escapeHtml(VOICE_HINT[voiceEnv()])}</p>`}`}
      ${this.draft ? this.viewDraft() : ''}
    </section>

    <section class="card">
      <div class="row-between"><h2>最近的账</h2>
        <button class="link" data-act="tab" data-tab="list">全部 ›</button></div>
      ${this.viewTxList(this.txOfMonth(month).slice(0, 5), { compact: true })}
    </section>`;
  }

  viewDraft() {
    const d = this.draft;
    const kindMeta = KIND_MAP[d.kind] || KIND_MAP.expense;
    // 报销回款也要看得到分类：它冲减的就是那笔垫付所在的分类
    const showCategory = kindMeta.counted !== false || d.kind === 'reimburse_back';
    return `
    <div class="draft">
      <div class="draft-head">
        <span class="conf" title="识别把握">${Math.round((d.confidence || 0) * 100)}%</span>
        <span>识别结果，确认或改一下</span>
      </div>
      ${d.warnings?.length ? `<ul class="warn-list">${d.warnings.map((w) => `<li>${U.escapeHtml(w)}</li>`).join('')}</ul>` : ''}
      <div class="grid2">
        <label class="field"><span>金额</span>
          <input type="number" inputmode="decimal" step="0.01" data-bind="draft" data-field="amount"
            value="${d.amount ?? ''}" placeholder="0.00">
        </label>
        <label class="field"><span>日期</span>
          <input type="date" data-bind="draft" data-field="occurredOn" value="${d.occurredOn || U.todayISO()}">
        </label>
        <label class="field"><span>类型</span>
          <select data-bind="draft" data-field="kind">
            ${KINDS.map((k) => `<option value="${k.key}" ${d.kind === k.key ? 'selected' : ''}>${k.name}</option>`).join('')}
          </select>
        </label>
        <label class="field"><span>人员</span>
          <select data-bind="draft" data-field="memberId">
            <option value="">不指定</option>
            ${this.members.map((m) => `<option value="${m.id}" ${d.memberId === m.id ? 'selected' : ''}>${U.escapeHtml(m.display_name)}</option>`).join('')}
          </select>
        </label>
        ${d.kind === 'transfer' ? `
        <label class="field"><span>转出账户</span>
          <select data-bind="draft" data-field="accountId">${this.accountOptions(d.accountId)}</select>
        </label>
        <label class="field"><span>转入账户</span>
          <select data-bind="draft" data-field="toAccountId">${this.accountOptions(d.toAccountId)}</select>
        </label>` : `
        <label class="field span2"><span>${d.kind === 'reimburse_back' ? '退回哪个账户' : '账户（可不选）'}</span>
          <select data-bind="draft" data-field="accountId">${this.accountOptions(d.accountId)}</select>
        </label>`}
        ${d.kind === 'reimburse_back' ? `
        <label class="field span2"><span>冲减哪笔垫付（选了会自动带上分类）</span>
          <select data-bind="draft" data-field="reimburseOf">
            <option value="">不指定</option>
            ${this.reimbursableOptions(d.reimburseOf)}
          </select>
        </label>` : ''}
        ${showCategory ? `
        <label class="field span2"><span>分类</span>
          <select data-bind="draft" data-field="categoryId">
            ${this.categoryOptions(d.kind === 'income' ? 'income' : 'expense', d.categoryId)}
          </select>
        </label>` : ''}
        <label class="field span2"><span>备注</span>
          <input type="text" data-bind="draft" data-field="note" value="${U.escapeHtml(d.note || '')}" placeholder="比如：牛奶、补习班">
        </label>
      </div>
      <div class="row-gap">
        <button class="btn primary" data-act="save-draft" ${this.busy ? 'disabled' : ''}>${this.busy ? '保存中…' : d.fromEdit ? '保存修改' : '确认入账'}</button>
        ${d.fromEdit ? `<button class="btn danger-ghost" data-act="delete-draft">删除</button>` : ''}
        <button class="btn ghost" data-act="${d.fromEdit ? 'cancel-edit' : 'cancel-draft'}">取消</button>
      </div>
      ${d.raw ? `<p class="fineprint">原话：${U.escapeHtml(d.raw)}</p>` : ''}
    </div>`;
  }

  accountOptions(selectedId) {
    const accounts = this.store.accounts || [];
    const opts = ['<option value="">不指定</option>'];
    for (const a of accounts) {
      opts.push(`<option value="${a.id}" ${selectedId === a.id ? 'selected' : ''}>${U.escapeHtml(a.name)}</option>`);
    }
    return opts.join('');
  }

  reimbursableOptions(selectedId) {
    const rows = [...this.cache.values()]
      .filter((t) => t.kind === 'expense' && t.reimbursable)
      .sort((a, b) => (a.occurred_on < b.occurred_on ? 1 : -1))
      .slice(0, 60);
    if (!rows.length) return '<option value="" disabled>（还没有标记待报销的支出）</option>';
    return rows.map((t) => {
      const cat = this.categoryById(t.category_id);
      const label = [t.occurred_on, cat ? cat.name : '', `${Number(t.amount).toFixed(2)}元`, t.note || '']
        .filter(Boolean).join(' ');
      return `<option value="${t.id}" ${selectedId === t.id ? 'selected' : ''}>${U.escapeHtml(label)}</option>`;
    }).join('');
  }

  categoryOptions(kind, selectedId) {    const list = this.categories.filter((c) => c.kind === kind);
    const parents = list.filter((c) => !c.parent_id);
    const opts = [];
    for (const p of parents) {
      const kids = list.filter((c) => c.parent_id === p.id);
      if (!kids.length) {
        opts.push(`<option value="${p.id}" ${selectedId === p.id ? 'selected' : ''}>${p.icon || ''} ${U.escapeHtml(p.name)}</option>`);
      } else {
        opts.push(`<optgroup label="${U.escapeHtml(p.name)}">
          <option value="${p.id}" ${selectedId === p.id ? 'selected' : ''}>${U.escapeHtml(p.name)}（大类）</option>
          ${kids.map((c) => `<option value="${c.id}" ${selectedId === c.id ? 'selected' : ''}>${U.escapeHtml(c.name)}</option>`).join('')}
        </optgroup>`);
      }
    }
    if (!opts.length) opts.push('<option value="">（还没有分类，请到「我的」里添加）</option>');
    return opts.join('');
  }

  /* ---- 流水页 ---- */

  viewList() {
    const rows = this.txOfMonth(this.month).sort((a, b) => {
      if (a.occurred_on !== b.occurred_on) return a.occurred_on < b.occurred_on ? 1 : -1;
      return String(b.created_at || '') < String(a.created_at || '') ? -1 : 1;
    });
    const t = A.totals(rows);
    const groups = U.groupBy(rows, (r) => r.occurred_on);
    return `
    <section class="card">
      <div class="month-nav">
        <button class="btn icon" data-act="month-prev">‹</button>
        <div class="month-title">${this.month.replace('-', ' 年 ')} 月</div>
        <button class="btn icon" data-act="month-next">›</button>
      </div>
      <div class="month-summary">
        <div><span class="lbl">支出</span><strong class="exp">${U.money(t.expense)}</strong></div>
        <div><span class="lbl">收入</span><strong class="inc">${U.money(t.income)}</strong></div>
        <div><span class="lbl">结余</span><strong class="${t.net >= 0 ? 'inc' : 'exp'}">${U.money(t.net)}</strong></div>
      </div>
    </section>
    ${rows.length ? [...groups.entries()].map(([date, list]) => `
      <section class="card day-group">
        <div class="day-head">
          <span>${this.dateLabel(date)}</span>
          <span class="muted">${U.money(A.totals(list).expense)}</span>
        </div>
        ${this.viewTxList(list)}
      </section>`).join('') : '<div class="empty">这个月还没有账目</div>'}
    <div class="row-gap">
      <button class="btn primary block" data-act="export-xlsx">导出这个月的 Excel（.xlsx）</button>
      <button class="btn ghost block" data-act="export-csv">导出 CSV（纯文本备份）</button>
    </div>`;
  }

  viewTxList(rows, { compact = false } = {}) {
    if (!rows || !rows.length) return '<p class="empty small">还没有记录</p>';
    const cmap = A.categoryMap(this.categories);
    return `<ul class="txlist">${rows.map((tx) => {
      const cat = tx.category_id ? cmap.get(tx.category_id) : null;
      const meta = KIND_MAP[tx.kind] || KIND_MAP.expense;
      const isExpense = tx.kind === 'expense' || tx.kind === 'reimburse_back';
      const label = cat ? cat.name : meta.name;
      const creator = this.memberName(tx.created_by);
      const owner = this.memberName(tx.member_id);
      const who = owner && owner !== creator ? `${owner} / ${creator}记` : owner || (creator ? `${creator}记` : '');
      return `<li class="tx" data-act="edit-tx" data-id="${tx.id}">
        <span class="tx-icon">${cat?.icon || (isExpense ? '💸' : '💵')}</span>
        <span class="tx-main">
          <span class="tx-title">${U.escapeHtml(label)}${tx.note ? ` · ${U.escapeHtml(tx.note)}` : ''}</span>
          <span class="tx-sub">${U.escapeHtml(who)}${tx.reimbursable ? ' · 待报销' : ''}${meta.counted === false ? ' · 不计收支' : ''}</span>
        </span>
        <span class="tx-amount ${isExpense ? 'exp' : 'inc'}">${isExpense ? '-' : '+'}${U.money(tx.amount).replace('¥', '')}</span>
        ${compact ? '' : `<button class="tx-del" data-act="delete-tx" data-id="${tx.id}" title="删除">×</button>`}
      </li>`;
    }).join('')}</ul>`;
  }

  dateLabel(iso) {
    const today = U.todayISO();
    if (iso === today) return '今天';
    if (iso === U.dateToISO(new Date(Date.now() - 86400000))) return '昨天';
    const d = U.isoToDate(iso);
    const week = '日一二三四五六'[d.getDay()];
    return `${d.getMonth() + 1}月${d.getDate()}日 周${week}`;
  }

  /* ---- 统计页 ---- */

  viewStats() {
    const month = this.month;
    const rows = this.txOfMonth(month);
    const prevMonth = U.shiftMonth(month, -1);
    const prevRows = this.txOfMonth(prevMonth);
    const t = A.totals(rows);
    const cmp = A.compareWithPrev(rows, prevRows);
    const expCats = A.byCategory(rows, this.categories, 'expense');
    const incCats = A.byCategory(rows, this.categories, 'income');
    const membersRows = A.byMember(rows, this.members, 'expense');
    const months = U.lastMonths(6, month);
    const trend = A.byMonth(this.txInRange(U.monthRange(months[0]).from, U.monthRange(month).to), months);
    const budgets = A.budgetStatus(this.monthBudgets, this.txOfMonth(month), this.categories, CONFIG.budgetWarnRatio);
    const catTrend = A.categoryTrend(
      this.txInRange(U.monthRange(months[0]).from, U.monthRange(month).to),
      this.categories,
      months,
      5,
    );
    // 饼图只画「正数」分类。报销回款会把某个分类冲成负数，若仍用合计做分母，
    // 扇形会超出整圈、百分比出现 148% 这种不可能的数字——所以分母用正数之和。
    const donutTotal = expCats.filter((c) => c.total > 0).reduce((a, b) => a + b.total, 0);
    const piePartial = Math.abs(U.round2(donutTotal - t.expense)) > 0.005;

    return `
    <section class="card">
      <div class="month-nav">
        <button class="btn icon" data-act="month-prev">‹</button>
        <div class="month-title">${month.replace('-', ' 年 ')} 月</div>
        <button class="btn icon" data-act="month-next">›</button>
      </div>
      <div class="kpi-row">
        <div class="kpi"><span>支出</span><strong class="exp">${U.money(t.expense)}</strong>
          <em class="${cmp.expense.pct > 0 ? 'up' : 'down'}">${this.pctText(cmp.expense.pct)}</em></div>
        <div class="kpi"><span>收入</span><strong class="inc">${U.money(t.income)}</strong>
          <em class="${cmp.income.pct > 0 ? 'up' : 'down'}">${this.pctText(cmp.income.pct)}</em></div>
        <div class="kpi"><span>结余</span><strong>${U.money(t.net)}</strong>
          <em class="${cmp.net.pct > 0 ? 'up' : 'down'}">${this.pctText(cmp.net.pct)}</em></div>
      </div>
      <p class="fineprint">同比上一月（${prevMonth}）。带「不计收支」的转账、借还款已排除在合计之外。</p>
    </section>

    <section class="card">
      <h2>支出构成</h2>
      <div class="donut-wrap">
        ${donutChart(expCats, { size: 168, total: donutTotal })}
        ${legend(expCats.slice(0, 6), donutTotal)}
      </div>
      ${piePartial ? `<p class="fineprint">本月有报销回款冲减了支出，饼图只画实际花出去的分类；各项之和 ${U.money(donutTotal)}，比上面的支出合计多 ${U.money(U.round2(donutTotal - t.expense))}。</p>` : ''}
    </section>

    <section class="card">
      <h2>近 6 个月趋势</h2>
      ${groupedBars(trend.map((m) => ({
        label: m.month.slice(5) + '月',
        values: [m.income, m.expense],
      })), { height: 150 })}
      <div class="chart-legend">
        <span><i style="background:#22c55e"></i>收入</span>
        <span><i style="background:#f87171"></i>支出</span>
      </div>
    </section>

    <section class="card">
      <h2>按人员</h2>
      ${horizontalBars(membersRows.map((m) => ({
        label: m.name, value: m.total, display: U.money(m.total),
      })))}
    </section>

    <section class="card">
      <h2>收入构成</h2>
      ${horizontalBars(incCats.map((c) => ({
        label: c.fullName, value: c.total, display: U.money(c.total),
      })), { colors: ['#22c55e', '#16a34a', '#4ade80', '#15803d'] })}
    </section>

    <section class="card">
      <h2>分类趋势（近 6 个月 · 支出前 5）</h2>
      ${catTrend.rows.length ? `
      <div class="table-scroll">
        <table class="trend-table">
          <thead><tr><th class="th-name">分类</th>
            ${catTrend.months.map((m) => `<th>${m.slice(5)}月</th>`).join('')}
          </tr></thead>
          <tbody>${catTrend.rows.map((row) => `
            <tr><td class="th-name">${U.escapeHtml(row.name)}</td>
              ${row.values.map((v) => `<td class="${v ? '' : 'zero'}">${v ? Math.round(v).toLocaleString('zh-CN') : '—'}</td>`).join('')}
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <p class="fineprint">看哪一类在涨：同一行从左到右，数字变大就是把钱花在这儿了。</p>` : '<p class="empty small">近 6 个月还没有支出</p>'}
    </section>

    <section class="card">
      <div class="row-between"><h2>预算</h2>
        <span class="muted">${month}</span></div>
      ${budgets.length ? `<ul class="budget-list">${budgets.map((b) => `
        <li class="budget ${b.state}">
          <div class="b-head"><span>${b.icon} ${U.escapeHtml(b.name)}</span>
            <span>${U.money(b.used)} / ${U.money(b.amount)}</span></div>
          <div class="b-track"><div class="b-fill" style="width:${Math.min(100, b.ratio * 100).toFixed(1)}%"></div></div>
          <div class="b-foot">${b.state === 'over'
    ? `已超支 ${U.money(Math.abs(b.remaining))}`
    : `还剩 ${U.money(b.remaining)}`}</div>
        </li>`).join('')}</ul>` : '<p class="empty small">还没设预算，去「我的」里设一个</p>'}
    </section>`;
  }

  pctText(pct) {
    if (!pct) return '持平';
    return `${pct > 0 ? '↑' : '↓'}${Math.abs(pct)}%`;
  }

  /* ---- 我的 ---- */

  viewMe() {
    const me = this.myMember;
    const family = this.store.family;
    const list = this.categories;
    const parents = list.filter((c) => !c.parent_id);
    return `
    <section class="card">
      <h2>家庭</h2>
      <div class="kv"><span>名称</span><strong>${U.escapeHtml(family?.name || '')}</strong></div>
      <div class="kv"><span>邀请码</span>
        <strong class="invite">${U.escapeHtml(family?.invite_code || '')}</strong>
        <button class="link" data-act="copy-invite">复制</button>
      </div>
      <p class="fineprint">家人各自注册账号，在「邀请码加入」里输入这 6 位码，就能看到同一本账。</p>
      <div class="members">${this.members.map((m) => `
        <span class="chip">${U.escapeHtml(m.display_name)}<em>${ROLE_MAP[m.role] || ''}</em></span>`).join('')}
      </div>
    </section>

    <section class="card">
      <h2>账户余额</h2>
      ${(() => {
    const balances = A.accountBalances([...this.cache.values()], this.store.accounts || []);
    if (!balances.length) return '<p class="empty small">还没有账户</p>';
    return `<ul class="acctlist">${balances.map((a) => `
          <li><span>${U.escapeHtml(a.name)}</span>
            <strong class="${a.balance < 0 ? 'exp' : ''}">${U.money(a.balance)}</strong></li>`).join('')}</ul>`;
  })()}
      <p class="fineprint">余额按账目推算（初始为 0）。转账会同时扣转出账户、加转入账户；
        借出/借入、报销回款也会动对应账户，但都不计入家庭收支合计。</p>
    </section>

    <section class="card">
      <h2>我的资料</h2>
      <div class="grid2">
        <label class="field"><span>称呼</span>
          <input id="profile-name" type="text" value="${U.escapeHtml(me?.display_name || '')}">
        </label>
        <label class="field"><span>身份</span>
          <select id="profile-role">
            ${ROLES.map((r) => `<option value="${r.key}" ${me?.role === r.key ? 'selected' : ''}>${r.name}</option>`).join('')}
          </select>
        </label>
      </div>
      <button class="btn primary" data-act="save-profile">保存</button>
    </section>

    <section class="card">
      <div class="row-between"><h2>预算</h2>
        <div class="month-nav small">
          <button class="btn icon" data-act="budget-month-prev">‹</button>
          <span>${this.budgetMonth}</span>
          <button class="btn icon" data-act="budget-month-next">›</button>
        </div>
      </div>
      <label class="field"><span>本月总预算（留空或 0 表示不设）</span>
        <input type="number" inputmode="decimal" data-budget-input="" value="${this.budgetValue(null)}" placeholder="0">
      </label>
      <p class="fineprint">也可以按分类设预算，用完 80% 会提醒，超了首页和统计页会标红。</p>
      <details class="cat-budget">
        <summary>按分类设预算</summary>
        ${parents.map((p) => `<label class="field"><span>${p.icon || ''} ${U.escapeHtml(p.name)}</span>
          <input type="number" inputmode="decimal" data-budget-input="${p.id}" value="${this.budgetValue(p.id)}" placeholder="0">
        </label>`).join('')}
      </details>
      <button class="btn primary" data-act="save-budget">保存预算</button>
    </section>

    <section class="card">
      <div class="row-between"><h2>分类管理</h2>
        <button class="link" data-act="toggle-cat-manager">${this.showCategoryManager ? '收起' : '展开'}</button></div>
      ${this.showCategoryManager ? `
        <div class="grid2">
          <label class="field"><span>名称</span><input id="new-cat-name" type="text" placeholder="比如：宠物"></label>
          <label class="field"><span>收支</span>
            <select id="new-cat-kind"><option value="expense">支出</option><option value="income">收入</option></select>
          </label>
          <label class="field span2"><span>挂在大类下（可不选）</span>
            <select id="new-cat-parent"><option value="">作为大类</option>
              ${parents.filter((p) => p.kind === 'expense').map((p) => `<option value="${p.id}">${U.escapeHtml(p.name)}</option>`).join('')}
            </select>
          </label>
          <label class="field span2"><span>识别关键词（逗号分隔，用于自动分类）</span>
            <input id="new-cat-words" type="text" placeholder="狗粮,猫砂,宠物医院">
          </label>
        </div>
        <button class="btn primary" data-act="add-category">添加分类</button>
        <ul class="catlist">${parents.map((p) => {
    const kids = list.filter((c) => c.parent_id === p.id);
    return `<li>
            <span class="cat-name">${p.icon || ''} ${U.escapeHtml(p.name)}<em>${p.kind === 'income' ? '收入' : '支出'}</em></span>
            <button class="tx-del" data-act="delete-category" data-id="${p.id}">×</button>
            ${kids.length ? `<ul class="subcats">${kids.map((c) => `
              <li><span>${U.escapeHtml(c.name)}</span>
                <button class="tx-del" data-act="delete-category" data-id="${c.id}">×</button></li>`).join('')}</ul>` : ''}
          </li>`;
  }).join('')}</ul>` : ''}
    </section>

    <section class="card">
      <h2>数据</h2>
      <div class="row-gap">
        <button class="btn ghost" data-act="export-xlsx">导出本月 Excel（.xlsx）</button>
        <button class="btn ghost" data-act="export-csv">导出本月 CSV</button>
        ${this.isDemo ? '<button class="btn ghost" data-act="reset-demo">重置演示数据</button>' : ''}
        <button class="btn ghost" data-act="signout">${this.isDemo ? '退出演示' : '退出登录'}</button>
      </div>
      ${this.isDemo ? `<p class="fineprint">当前是演示模式：数据只存在这台设备的浏览器里，换设备看不到。
        填好 <code>src/config.js</code> 里的 Supabase 地址和 key 后，就会自动切换成多人共享的真实账本。</p>` : ''}
      <p class="fineprint">账号：${U.escapeHtml(this.store.session?.user?.email || '本机演示')}</p>
    </section>`;
  }

  budgetValue(categoryId) {
    const row = this.budgets.find((b) => (b.category_id || null) === (categoryId || null));
    return row ? String(Number(row.amount)) : '';
  }
}

/* ------------------------------------------------------------------ */

export async function mount(root) {
  const store = createStore(CONFIG);
  const app = new App(root, store);
  await app.init();
  return app;
}

export { App };
