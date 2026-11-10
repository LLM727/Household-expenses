/**
 * 模拟 GitHub Pages 的托管方式，检查「推上去会不会白屏」。
 *
 * 为什么需要它：GitHub Pages 会把仓库放在 **子路径** 下（https://用户名.github.io/Household-expenses/），
 * 而不是域名根目录。本地 `node tools/serve.js` 跑在根路径上，所以这些东西在本地一切正常、推上去就废：
 *   - 写成绝对路径的引用：/src/app.js
 *   - manifest 里写 start_url: "/"（手机添加到桌面后打开 404）
 *   - 引用外网 CDN（国内网络一慢就白屏）
 * 这个脚本把仓库复制到临时目录的 Household-expenses/ 子目录下，起一个和 Pages 行为一致的静态服务器，
 * 然后从首页开始把所有引用递归请求一遍，任何 404 或外链都会报出来。
 *
 * 用法：node tools/check-pages.js
 */

import http from 'node:http';
import {
  createReadStream,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PREFIX = '/Household-expenses'; // Pages 上的子路径，等于仓库名
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

const problems = [];
const notes = [];
const bad = (title, detail) => problems.push({ title, detail });

/* ---------------- 1. 静态检查：不许有绝对路径与外链 ---------------- */

const SKIP_DIRS = new Set(['.git', 'node_modules', 'test', 'tools', 'supabase']);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** 从 html / js / css 里找出所有「会带来一次网络请求」的引用 */
function extractRefs(file, text) {
  const refs = [];
  const push = (ref) => {
    const value = (ref || '').trim();
    if (!value) return;
    if (value.startsWith('#') || value.startsWith('data:')) return;
    refs.push(value);
  };

  if (file.endsWith('.html')) {
    for (const m of text.matchAll(/(?:src|href)\s*=\s*"([^"]*)"/g)) push(m[1]);
    for (const m of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) push(m[1]);
  } else if (file.endsWith('.js') || file.endsWith('.mjs')) {
    for (const m of text.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)) push(m[1]);
    for (const m of text.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) push(m[1]);
  } else if (file.endsWith('.css')) {
    for (const m of text.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) push(m[1]);
    for (const m of text.matchAll(/@import\s+['"]([^'"]+)['"]/g)) push(m[1]);
  }
  return refs;
}

for (const file of walk(ROOT)) {
  const ext = extname(file).toLowerCase();
  if (!['.html', '.js', '.mjs', '.css'].includes(ext)) continue;
  const text = readFileSync(file, 'utf8');
  const rel = file.slice(ROOT.length + 1).replace(/\\/g, '/');
  for (const ref of extractRefs(file, text)) {
    if (/^https?:\/\//i.test(ref)) {
      bad('外链依赖', `${rel} 引用了 ${ref}（外网不通就白屏，仓库要自给自足）`);
    } else if (ref.startsWith('/')) {
      bad('绝对路径', `${rel} 引用了 ${ref}（Pages 在子路径下，绝对路径会 404，改成 ./ 开头）`);
    }
  }
}

/* ---------------- 2. manifest：起手页必须落在子路径内 ---------------- */

const manifestPath = join(ROOT, 'manifest.json');
if (!existsSync(manifestPath)) {
  bad('缺 manifest', '找不到 manifest.json，「添加到桌面」会不完整');
} else {
  let manifest = null;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    bad('manifest 不是合法 JSON', err.message);
  }
  if (manifest) {
    for (const key of ['start_url', 'scope']) {
      const value = manifest[key];
      if (value === undefined) continue;
      if (String(value).startsWith('/')) {
        bad('manifest 绝对路径', `${key} 写成了 ${value}，子路径下打开会 404，改成 ./ 开头`);
      }
    }
    for (const icon of manifest.icons || []) {
      if (String(icon.src || '').startsWith('/')) bad('manifest 绝对路径', `图标 ${icon.src}`);
      if (/^https?:/i.test(String(icon.src || ''))) bad('外链依赖', `图标 ${icon.src}`);
    }
    if (!manifest.start_url) bad('manifest 缺 start_url', '手机加到桌面后不知道从哪一页打开');
  }
}

/* ---------------- 3. .nojekyll：别让 Jekyll 动文件 ---------------- */

if (!existsSync(join(ROOT, '.nojekyll'))) {
  bad('缺 .nojekyll', 'GitHub Pages 默认会过一遍 Jekyll，加一个空文件 .nojekyll 让它原样发布（本仓库应已自带）');
}

/* ---------------- 4. 真的起一个「子路径」服务器，把引用跑一遍 ---------------- */

const staging = mkdtempSync(join(tmpdir(), 'pages-check-'));
const siteRoot = join(staging, 'Household-expenses');

function copySite() {
  cpSync(ROOT, siteRoot, {
    recursive: true,
    filter: (src) => {
      const name = src.slice(ROOT.length + 1).split(/[\\/]/)[0];
      return !['.git', 'node_modules'].includes(name);
    },
  });
}

function startServer() {
  return new Promise((resolveServer) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
      if (!urlPath.startsWith(PREFIX)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found（Pages 不会把仓库放到根路径）');
        return;
      }
      let rel = urlPath.slice(PREFIX.length) || '/';
      if (rel === '/' || rel.endsWith('/')) rel += 'index.html';
      const filePath = join(siteRoot, rel.replace(/^\/+/, ''));
      let stat;
      try {
        stat = statSync(filePath);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404');
        return;
      }
      if (stat.isDirectory()) {
        res.writeHead(302, { Location: `${urlPath.replace(/\/$/, '')}/index.html` }).end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
        'Content-Length': stat.size,
      });
      createReadStream(filePath).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolveServer(server));
  });
}

function jsonContentTypeOk(url) {
  return url.endsWith('.json');
}

async function crawl(base) {
  const queue = [`${PREFIX}/`];
  const seen = new Set();
  const ok = [];

  while (queue.length) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);

    const response = await fetch(new URL(url, base));
    if (!response.ok) {
      bad('引用 404', `${url} → HTTP ${response.status}`);
      continue;
    }
    const type = response.headers.get('content-type') || '';
    if (jsonContentTypeOk(url) && !/json/i.test(type)) {
      bad('MIME 不对', `${url} 被当成 ${type}，浏览器可能不认（Pages 上 .json 会是 application/json）`);
    }
    const body = await response.text();
    if (!body.length) {
      bad('空文件', `${url} 内容是空的`);
      continue;
    }
    ok.push({ url, type, size: body.length });

    // 只顺着同站相对引用往下爬（按 Content-Type 判断文件类型，别只看后缀：目录首页没有后缀）
    const kind = /html/i.test(type) ? 'page.html'
      : /javascript/i.test(type) ? 'module.js'
        : /css/i.test(type) ? 'style.css'
          : null;
    if (kind) {
      for (const ref of extractRefs(kind, body)) {
        if (/^https?:\/\//i.test(ref) || ref.startsWith('data:') || ref.startsWith('#')) continue;
        const next = new URL(ref, `http://x${url}`).pathname;
        if (!next.startsWith(PREFIX)) {
          bad('引用跑到子路径外面', `${url} 里的 ${ref} 解析成 ${next}`);
          continue;
        }
        queue.push(next);
      }
    }
  }
  return ok;
}

let served = [];
let server = null;
try {
  copySite();
  server = await startServer();
  const { port } = server.address();
  served = await crawl(`http://127.0.0.1:${port}`);
} catch (err) {
  bad('模拟托管时出错', err.message);
} finally {
  server?.close();
  rmSync(staging, { recursive: true, force: true });
}

/* ---------------- 5. 报告 ---------------- */

console.log('检查 GitHub Pages 子路径托管（/Household-expenses/）\n');
for (const item of served) {
  console.log(`  ✅ ${item.url}  ${item.type.split(';')[0]}  ${item.size} 字节`);
}
notes.push(`共 ${served.length} 个引用在子路径下成功取回`);

console.log('');
if (problems.length) {
  console.log(`❌ 发现 ${problems.length} 个问题：\n`);
  for (const p of problems) console.log(`  · ${p.title}：${p.detail}`);
  console.log('\n这些在本地根路径预览时看不出来，推上 GitHub Pages 就会白屏或图标失效。');
  process.exit(1);
} else {
  console.log(`✅ 没问题：${notes.join('；')}。`);
  console.log('   所有引用都是相对路径、没有外链，manifest 起手页落在子路径内，.nojekyll 已就位。');
}
