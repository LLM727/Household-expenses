/**
 * 极简 Supabase 客户端：只用 fetch 直连 Auth 与 PostgREST 接口，零依赖。
 *
 * 之所以不用 @supabase/supabase-js：避免引入构建步骤与 CDN 依赖，
 * 国内网络下更稳；本项目用到的能力只有「登录/注册/刷新令牌」和「表读写/RPC」。
 */

const SESSION_KEY = 'he.session.v1';

export class SupabaseError extends Error {
  constructor(message, { status, code, hint, details } = {}) {
    super(message);
    this.name = 'SupabaseError';
    this.status = status;
    this.code = code;
    this.hint = hint;
    this.details = details;
  }
}

function buildQuery(filters) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters || {})) {
    if (value === undefined || value === null) continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export class SupabaseClient {
  constructor({ url, anonKey, storage } = {}) {
    this.url = String(url || '').replace(/\/+$/, '');
    this.anonKey = anonKey || '';
    this.storage = storage || globalThis.localStorage;
    this.session = this._readSession();
    this._refreshPromise = null;
  }

  /* ---------- 会话持久化 ---------- */

  _readSession() {
    try {
      return JSON.parse(this.storage.getItem(SESSION_KEY) || 'null');
    } catch {
      return null;
    }
  }

  _writeSession(session) {
    this.session = session;
    if (session) this.storage.setItem(SESSION_KEY, JSON.stringify(session));
    else {
      this.storage.removeItem(SESSION_KEY);
    }
  }

  get userId() {
    return this.session?.user?.id || null;
  }

  get email() {
    return this.session?.user?.email || null;
  }

  /* ---------- 底层请求 ---------- */

  _headers({ auth = true, extra = {} } = {}) {
    const headers = {
      apikey: this.anonKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...extra,
    };
    if (auth) {
      const token = this.session?.access_token || this.anonKey;
      headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  }

  async _request(path, { method = 'GET', body, auth = true, extraHeaders } = {}) {
    const res = await fetch(`${this.url}${path}`, {
      method,
      headers: this._headers({ auth, extra: extraHeaders }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    if (!res.ok) {
      const message =
        data?.msg || data?.message || data?.error_description || data?.error || `请求失败（HTTP ${res.status}）`;
      throw new SupabaseError(message, {
        status: res.status,
        code: data?.code || data?.error_code,
        hint: data?.hint,
        details: data,
      });
    }
    return data;
  }

  /* ---------- 认证 ---------- */

  _storeToken(payload) {
    if (!payload?.access_token) return null;
    const session = {
      access_token: payload.access_token,
      refresh_token: payload.refresh_token,
      // 提前 60 秒视为过期，避免临界失败
      expires_at: Date.now() + (Number(payload.expires_in || 3600) - 60) * 1000,
      user: payload.user || this.session?.user,
    };
    this._writeSession(session);
    return session;
  }

  async signUp(email, password, displayName) {
    const data = await this._request('/auth/v1/signup', {
      method: 'POST',
      body: { email, password, data: { display_name: displayName } },
      auth: false,
    });
    if (!data?.access_token) {
      // 项目开启了邮箱确认：注册成功但还没有会话
      throw new SupabaseError('注册成功，但需要先点邮件里的确认链接才能登录', {
        code: 'email_confirmation_required',
      });
    }
    this._storeToken(data);
    return data;
  }

  async signIn(email, password) {
    const data = await this._request('/auth/v1/token?grant_type=password', {
      method: 'POST',
      body: { email, password },
      auth: false,
    });
    this._storeToken(data);
    return data;
  }

  async signOut() {
    try {
      if (this.session?.access_token) {
        await this._request('/auth/v1/logout', { method: 'POST' });
      }
    } catch {
      // 本地照样退出
    }
    this._writeSession(null);
  }

  async refresh() {
    if (!this.session?.refresh_token) throw new SupabaseError('登录已失效，请重新登录');
    if (!this._refreshPromise) {
      this._refreshPromise = (async () => {
        const data = await this._request('/auth/v1/token?grant_type=refresh_token', {
          method: 'POST',
          body: { refresh_token: this.session.refresh_token },
          auth: false,
        });
        this._storeToken(data);
        return data;
      })().finally(() => {
        this._refreshPromise = null;
      });
    }
    return this._refreshPromise;
  }

  async ensureFresh() {
    if (!this.session) return;
    if (this.session.expires_at && Date.now() >= this.session.expires_at) {
      try {
        await this.refresh();
      } catch {
        this._writeSession(null);
      }
    }
  }

  /* ---------- 数据表 ---------- */

  /**
   * @param {string} table
   * @param {object} opts
   * @param {string} [opts.select]
   * @param {object} [opts.filters] 形如 { family_id: 'eq.xxx', occurred_on: 'gte.2026-01-01' }
   * @param {string} [opts.order]   形如 'occurred_on.desc'
   * @param {number} [opts.limit]
   * @param {number} [opts.offset]
   * @param {string} [opts.method]
   * @param {any}    [opts.body]
   * @param {string} [opts.prefer]  例如 'return=representation'
   */
  async table(tableName, opts = {}) {
    await this.ensureFresh();
    const { select, filters = {}, order, limit, offset, method = 'GET', body, prefer } = opts;
    const query = { ...filters };
    if (select) query.select = select;
    if (order) query.order = order;
    if (limit) query.limit = String(limit);
    if (offset) query.offset = String(offset);

    const extraHeaders = {};
    if (prefer) extraHeaders.Prefer = prefer;
    else if (method === 'POST' || method === 'PATCH') extraHeaders.Prefer = 'return=representation';

    return this._request(`/rest/v1/${tableName}${buildQuery(query)}`, {
      method,
      body,
      extraHeaders,
    });
  }

  async rpc(fn, args = {}) {
    await this.ensureFresh();
    return this._request(`/rest/v1/rpc/${fn}`, { method: 'POST', body: args });
  }
}
