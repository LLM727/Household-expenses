#!/usr/bin/env node
/**
 * 上线自检：填好 src/config.js 之后跑一下，它会真的去问 Supabase 几个问题，
 * 告诉你「表建了没、权限开了没、注册能用不能用」，不用等页面报错才去猜。
 *
 *   node tools/check-config.js
 *
 * 只读：不写任何数据，也不会创建账号。
 */

import { pathToFileURL } from 'node:url';
import { CONFIG, isConfigured } from '../src/config.js';

const TIMEOUT_MS = 12000;

async function req(url, init = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, text, json };
  } finally {
    clearTimeout(timer);
  }
}

const OK = 'ok';
const WARN = 'warn';
const FAIL = 'fail';

/**
 * 纯函数：把探测结果翻译成人话。
 * @returns {Array<{level:string, title:string, detail:string}>}
 */
export function judge({ settings, tables, rpc, networkError }) {
  const out = [];

  if (networkError) {
    out.push({
      level: FAIL,
      title: '连不上 Supabase',
      detail: `${networkError}（检查地址是否写对、电脑能不能上外网）`,
    });
    return out;
  }

  // 1. 项目地址是否有效
  if (settings?.status === 200 && settings.json) {
    out.push({ level: OK, title: '项目地址有效', detail: 'Supabase 有回应' });
  } else if (settings?.status === 401 || settings?.status === 403) {
    out.push({
      level: FAIL,
      title: 'anon key 不对',
      detail: 'Supabase 拒绝了这把钥匙。回去 Project Settings → API 重新复制 anon public 那一串（别复制 service_role）',
    });
  } else {
    out.push({
      level: FAIL,
      title: '项目地址可能不对',
      detail: `返回 HTTP ${settings?.status ?? '无'}。地址形如 https://abcdefgh.supabase.co（末尾不要带斜杠、不要带 /rest/v1）`,
    });
  }

  // 2. 表与行级权限
  if (tables?.status === 200) {
    const rows = Array.isArray(tables.json) ? tables.json : [];
    if (rows.length === 0) {
      // 注意措辞：这里只能说「读不到」，不能说「行级权限生效」。
      // RLS 打开时会过滤成空数组，可**一张新建的空表在 RLS 关闭时同样返回空数组**，
      // 光靠读接口分不开这两种情况（要分得清就得尝试写入，而这个脚本承诺只读）。
      // 所以给结论时留一句「顺手确认一下」，把确定性交给 pg_tables 那句 SQL。
      out.push({
        level: OK,
        title: '数据表已建好，匿名读不到任何行',
        detail:
          '符合预期。不过「读不到」在「权限已开」和「表还是空的」两种情况下表现一样，' +
          '刚建好的项目本来就是空的，所以光靠这句还不能 100% 确认权限。' +
          '上线前顺手在 SQL Editor 跑一句确认：' +
          "select tablename, rowsecurity from pg_tables where schemaname='public' order by tablename; " +
          '应该看到 6 行、每行 rowsecurity 都是 true。',
      });
    } else {
      out.push({
        level: FAIL,
        title: '⚠️ 行级权限没生效，先别上线',
        detail: `匿名竟然读到了 ${rows.length} 行家庭数据。请整段重新运行 supabase/schema.sql（里面有 enable row level security）`,
      });
    }
  } else if (tables?.status === 404 || /does not exist|PGRST205/i.test(tables?.text || '')) {
    out.push({
      level: FAIL,
      title: '数据表不存在',
      detail: 'schema.sql 还没跑。去 Supabase 左侧 SQL Editor → New query，把 supabase/schema.sql 整段粘进去 → Run',
    });
  } else {
    out.push({
      level: FAIL,
      title: '读表失败',
      detail: `HTTP ${tables?.status ?? '无'}：${(tables?.text || '').slice(0, 160)}`,
    });
  }

  // 3. 数据库函数（邀请码 / 建家）
  const rpcText = rpc?.text || '';
  if (rpc?.status === 404 || /PGRST202|Could not find the function/i.test(rpcText)) {
    out.push({
      level: FAIL,
      title: '数据库函数缺失',
      detail: 'schema.sql 没跑完。整段重新运行一次，最后应该显示 Success. No rows returned',
    });
  } else if (rpc && rpc.status >= 200 && rpc.status < 500) {
    out.push({
      level: OK,
      title: '建家/邀请码函数已就位',
      detail: '未登录调用被正确拒绝，说明函数在、权限也对',
    });
  } else {
    out.push({
      level: WARN,
      title: '函数状态没看清',
      detail: `HTTP ${rpc?.status ?? '无'}：${rpcText.slice(0, 160)}`,
    });
  }

  // 4. 注册与邮箱确认
  if (settings?.json) {
    const s = settings.json;
    if (s.disable_signup === true) {
      out.push({
        level: FAIL,
        title: '注册被关掉了',
        detail: 'Authentication → Sign In / Providers → Email，把 Enable signup 打开',
      });
    } else if (s.mailer_autoconfirm === true) {
      out.push({
        level: OK,
        title: '注册后可直接登录（邮箱确认已关）',
        detail: '家人注册完就能用，不用点邮件链接',
      });
    } else if (s.mailer_autoconfirm === false) {
      out.push({
        level: WARN,
        title: '邮箱确认还开着',
        detail: '家人注册后会卡在「请点邮件里的链接」。去 Authentication → Sign In / Providers → Email，把 Confirm email 关掉',
      });
    }
  }

  return out;
}

async function main() {
  console.log('\n家庭记账本 · 上线自检\n' + '='.repeat(40));

  if (!isConfigured()) {
    console.log('\n❌ src/config.js 里的 supabaseUrl / supabaseAnonKey 还是空的。');
    console.log('   先把这两项填上（步骤见 DEPLOY.md 第 4 步），再回来跑这个检查。');
    console.log('   现在这种情况下打开网页是「演示模式」，功能都能试，但数据只存本机。\n');
    process.exit(1);
  }

  const url = String(CONFIG.supabaseUrl).replace(/\/+$/, '');
  const key = CONFIG.supabaseAnonKey;
  const headers = { apikey: key, Authorization: `Bearer ${key}` };

  console.log(`\n项目地址：${url}`);
  console.log('开始探测…\n');

  let settings;
  let tables;
  let rpc;
  let networkError = null;

  try {
    settings = await req(`${url}/auth/v1/settings`, { headers });
    tables = await req(`${url}/rest/v1/families?select=id&limit=1`, { headers });
    // 故意不带登录令牌：函数存在的话会返回 401/400，不存在才是 404
    rpc = await req(`${url}/rest/v1/rpc/create_family`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      // 参数名必须和 schema.sql 里 create_family(p_family_name, p_display_name, p_role)
      // 完全一致。PostgREST 是按参数名匹配函数的，写错一个名字它就找不到函数，
      // 返回 PGRST202「Could not find the function」——看起来像「函数没建」，
      // 其实是自检自己传错了参数。曾经这里写成 p_name，害得用户白重跑一遍 schema。
      body: JSON.stringify({ p_family_name: 'x', p_display_name: 'x', p_role: 'father' }),
    });
  } catch (err) {
    networkError = err?.name === 'AbortError' ? '请求超时' : (err?.message || String(err));
  }

  const results = judge({ settings, tables, rpc, networkError });

  for (const r of results) {
    const mark = r.level === OK ? '✅' : r.level === WARN ? '⚠️ ' : '❌';
    console.log(`${mark} ${r.title}`);
    if (r.detail) console.log(`   ${r.detail}`);
    console.log('');
  }

  const failed = results.filter((r) => r.level === FAIL).length;
  const warned = results.filter((r) => r.level === WARN).length;

  console.log('='.repeat(40));
  if (failed === 0 && warned === 0) {
    console.log('全部通过 🎉 可以推送代码开 GitHub Pages 了（DEPLOY.md 第 5、6 步）\n');
    process.exit(0);
  }
  if (failed === 0) {
    console.log(`有 ${warned} 项提醒，不影响使用，但建议按上面的说明调一下。\n`);
    process.exit(0);
  }
  console.log(`有 ${failed} 项必须修，修完再跑一次这个检查。\n`);
  process.exit(1);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error('自检脚本自身出错：', err);
    process.exit(2);
  });
}
