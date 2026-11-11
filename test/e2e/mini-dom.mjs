/**
 * 极简 DOM 替身：只支持 App 真正用到的那一点点能力——
 * 设 innerHTML、按 id 取表单控件、读 / 写 .value。
 *
 * 不追求还原浏览器：事件绑定是空操作（这个项目的事件接线由离线测试的
 * 「data-act 全量对应」检查覆盖），这里要验的是
 * 「界面方法 → RemoteStore → HTTP → 真 Postgres」这条链路。
 */

class MiniControl {
  constructor(id) {
    this.id = id;
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.dataset = {};
    this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
  }
}

export class MiniEl {
  constructor() {
    this._html = '';
    this._controls = new Map();
    this.dataset = {};
    this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
  }

  get innerHTML() {
    return this._html;
  }

  set innerHTML(value) {
    this._html = String(value);
  }

  addEventListener() {}

  removeEventListener() {}

  querySelector(selector) {
    const match = /^#([\w-]+)$/.exec(String(selector));
    if (!match) return null;
    const id = match[1];
    if (!this._html.includes(`id="${id}"`)) return null;
    if (!this._controls.has(id)) this._controls.set(id, new MiniControl(id));
    return this._controls.get(id);
  }

  /**
   * 只支持属性选择器一种形式（`[data-budget-input]`），因为 App 只用到这一种。
   *
   * 之前这里恒返回空数组，后果是 `saveBudget()` 拿到 0 个输入框、一声不响地什么都不做——
   * 预算功能在端到端测试里等于不存在，而测试还是绿的。宁可让替身多支持一点。
   */
  querySelectorAll(selector) {
    const attr = /^\[([\w-]+)\]$/.exec(String(selector).trim());
    if (!attr) return [];
    const name = attr[1];
    // 把 HTML 里所有带这个属性的标签找出来，按出现顺序造控件。
    const re = new RegExp(`<[^>]*\\s${name}="([^"]*)"[^>]*>`, 'g');
    const out = [];
    let m;
    while ((m = re.exec(this._html)) !== null) {
      const key = `${name}:${m.index}`;
      if (!this._controls.has(key)) {
        const control = new MiniControl(key);
        // 属性名转成 dataset：data-budget-input → budgetInput
        const camel = name.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        control.dataset[camel] = m[1];
        // 顺手把同一标签上的 value="..." 读进来，模拟「页面上原本填的值」
        const valueMatch = /value="([^"]*)"/.exec(m[0]);
        control.value = valueMatch ? valueMatch[1] : '';
        this._controls.set(key, control);
      }
      out.push(this._controls.get(key));
    }
    return out;
  }

  /** 测试辅助：给某个输入框填值。找不到控件时立刻报错，避免「填了但没生效」的假通过 */
  fill(selector, value) {
    if (String(selector).startsWith('[')) {
      const all = this.querySelectorAll(selector);
      if (!all.length) throw new Error(`页面上找不到输入框 ${selector}`);
      all.forEach((c) => { c.value = value; });
      return this;
    }
    const control = this.querySelector(selector);
    if (!control) throw new Error(`页面上找不到输入框 ${selector}`);
    control.value = value;
    return this;
  }

  /**
   * 测试辅助：按 data-budget-input 的值（分类 id，'' 表示家庭总预算）指定填哪个框。
   * 预算页上有一排同名输入框，光按属性选会把它们全填成同一个数。
   */
  fillBudget(categoryId, value) {
    const target = this.querySelectorAll('[data-budget-input]')
      .find((c) => (c.dataset.budgetInput || '') === (categoryId || ''));
    if (!target) throw new Error(`页面上找不到预算输入框（分类 ${categoryId || '总预算'}）`);
    target.value = String(value);
    return this;
  }

  /** 测试辅助：断言某个文案出现在当前页面 */
  has(text) {
    return this._html.includes(text);
  }
}
