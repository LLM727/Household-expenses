// 网络体检：确认 github.com 这条线到底通没通。
// 用法：node tools/check-net.mjs
// 为什么要这个：这台机器上 GitHub 是「TCP 能连、HTTPS 被重置」的状态，
// 光看 ping 或 TCP 端口会误判成「通的」。必须真的发一次 HTTPS 请求才算数。

const targets = [
  { name: 'GitHub API（推送用不到，但能确认出网大方向）', url: 'https://api.github.com/zen' },
  { name: 'GitHub 网页（登录/建仓库要用）', url: 'https://github.com/login/device' },
  { name: 'GitHub git 端点（推送要用）', url: 'https://github.com/LLM727/Household-expenses.git/info/refs?service=git-upload-pack' },
  { name: 'Supabase', url: 'https://supabase.com' },
];

const timeoutMs = 15000;

async function probe(t) {
  const started = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(t.url, { signal: ctl.signal, redirect: 'manual' });
    return { ok: true, ms: Date.now() - started, status: res.status };
  } catch (err) {
    const code = err?.cause?.code || err?.name || err?.message || '未知';
    return { ok: false, ms: Date.now() - started, code: String(code) };
  } finally {
    clearTimeout(timer);
  }
}

const results = [];
for (const t of targets) {
  results.push({ ...t, ...(await probe(t)) });
}

let allOk = true;
for (const r of results) {
  if (r.ok) {
    console.log(`✅ ${r.name}\n   HTTP ${r.status}，${r.ms}ms`);
  } else {
    allOk = false;
    console.log(`❌ ${r.name}\n   ${r.code}，${r.ms}ms`);
  }
}

console.log('');
if (allOk) {
  console.log('可以继续了：网络通，接下来我可以建仓库、推送、开 Pages。');
  process.exit(0);
}

console.log('还没通。常见原因：');
console.log('  1. 代理开了但没开「全局/系统代理」——浏览器走了代理，命令行没走');
console.log('  2. 代理刚开，网络还没稳定，等十几秒再跑一次');
console.log('  3. 只代理了浏览器插件（SwitchyOmega 之类），命令行仍然直连');
console.log('');
console.log('命令行要走代理的话，需要设置环境变量，例如（端口按你自己代理软件填）：');
console.log('  $env:HTTPS_PROXY="http://127.0.0.1:7890"');
console.log('  $env:HTTP_PROXY="http://127.0.0.1:7890"');
process.exit(1);
