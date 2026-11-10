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

  querySelectorAll() {
    return [];
  }

  /** 测试辅助：给某个输入框填值。找不到控件时立刻报错，避免「填了但没生效」的假通过 */
  fill(selector, value) {
    const control = this.querySelector(selector);
    if (!control) throw new Error(`页面上找不到输入框 ${selector}`);
    control.value = value;
    return this;
  }

  /** 测试辅助：断言某个文案出现在当前页面 */
  has(text) {
    return this._html.includes(text);
  }
}
