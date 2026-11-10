#!/usr/bin/env node
/**
 * 部署前资源检查：防止「在自己电脑上好好的，一上 GitHub Pages 就白屏」。
 *
 *   node tools/check-assets.js
 *
 * 它检查三件事：
 *   1. index.html 里引用的每个文件都真实存在，而且**大小写完全一致**
 *      （Windows 不区分大小写，GitHub Pages 是 Linux，区分——这是最常见的白屏原因）
 *   2. 每个 .js 的 import 路径、每个 .css 的 url() 同样存在且大小写正确
 *   3. 浏览器代码里没有误用 Node 才有的东西（require / process.env / node: 模块）
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const checked = new Set();

function rel(p) {
  return relative(ROOT, p).split(sep).join('/');
}

/** 逐段比对目录项，确认大小写与磁盘一致（Windows 上 existsSync 不区分大小写，不能直接用） */
function existsWithExactCase(target) {
  const parts = normalize(target).split(sep).filter(Boolean);
  let current = parts[0].endsWith(':') ? parts.shift() + sep : sep;
  for (const part of parts) {
    const dir = current === sep ? sep : current;
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return false;
    }
    if (!entries.includes(part)) return false;
    current = join(dir, part);
  }
  return true;
}

function checkFile(absPath, fromLabel) {
  if (checked.has(absPath)) return;
  checked.add(absPath);

  if (!existsWithExactCase(absPath)) {
    problems.push(`❌ ${rel(absPath)} 不存在或大小写不对（被 ${fromLabel} 引用）`);
    return;
  }
  let st;
  try {
    st = statSync(absPath);
  } catch {
    return;
  }
  if (!st.isFile()) {
    problems.push(`❌ ${rel(absPath)} 不是文件（被 ${fromLabel} 引用）`);
    return;
  }
}

function importSpecsFrom(code) {
  const specs = new Set();
  for (const m of code.matchAll(/(?:import|export)[^;\n]*?from\s*["']([^"']+)["']/g)) specs.add(m[1]);
  for (const m of code.matchAll(/(?:^|\n)\s*import\s*["']([^"']+)["']/g)) specs.add(m[1]);
  return specs;
}

function scanHtml(file) {
  const html = readFileSync(file, 'utf8');
  const refs = new Set();
  for (const m of html.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']/g)) {
    const raw = m[1].trim();
    if (!raw || raw.startsWith('#') || /^(https?:)?\/\//.test(raw) || raw.startsWith('data:')) continue;
    refs.add(raw.split('#')[0].split('?')[0]);
  }
  for (const ref of refs) {
    const abs = resolve(dirname(file), ref);
    checkFile(abs, rel(file));
    if (abs.endsWith('.js') && existsWithExactCase(abs)) scanJs(abs);
    else if (abs.endsWith('.css') && existsWithExactCase(abs)) scanCss(abs);
  }

  // 内联 <script type="module"> 里的 import 同样要检查
  for (const m of html.matchAll(/<script[^>]*type\s*=\s*["']module["'][^>]*>([\s\S]*?)<\/script>/g)) {
    for (const spec of importSpecsFrom(m[1])) {
      if (!spec.startsWith('.')) continue;
      const abs = resolve(dirname(file), spec);
      checkFile(abs, `${rel(file)} 内联脚本`);
      if (abs.endsWith('.js') && existsWithExactCase(abs)) scanJs(abs);
    }
  }
  return refs;
}

function scanJs(file) {
  const code = readFileSync(file, 'utf8');
  const specs = importSpecsFrom(code);
  for (const spec of specs) {
    if (!spec.startsWith('.')) continue;
    const abs = resolve(dirname(file), spec);
    checkFile(abs, rel(file));
    if (abs.endsWith('.js') && existsWithExactCase(abs)) scanJs(abs);
  }

  // 浏览器代码里不能出现 Node 专有的东西
  if (/(^|[^.\w])require\s*\(/.test(code)) problems.push(`❌ ${rel(file)} 用了 require()，浏览器里会直接报错`);
  if (/process\.env/.test(code)) problems.push(`❌ ${rel(file)} 用了 process.env，浏览器里不存在`);
  for (const m of code.matchAll(/from\s*["'](node:[^"']+)["']/g)) {
    problems.push(`❌ ${rel(file)} 引用了 Node 内置模块 ${m[1]}`);
  }
  // 裸导入（不带 ./ 也不是 node:），在浏览器里没有 importmap 会 404
  for (const spec of specs) {
    if (!spec.startsWith('.') && !spec.startsWith('node:')) {
      problems.push(`❌ ${rel(file)} 用了裸导入 "${spec}"，浏览器解析不了（本项目应零依赖）`);
    }
  }
}

function scanCss(file) {
  const css = readFileSync(file, 'utf8');
  for (const m of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
    const raw = m[1].trim();
    if (!raw || raw.startsWith('data:') || /^(https?:)?\/\//.test(raw)) continue;
    checkFile(resolve(dirname(file), raw.split('#')[0].split('?')[0]), rel(file));
  }
}

console.log('\n部署前资源检查\n' + '='.repeat(40));
const entries = scanHtml(join(ROOT, 'index.html'));
console.log(`index.html 直接引用 ${entries.size} 个文件，连同 import 共检查 ${checked.size} 个`);

for (const p of problems) console.log(p);

if (problems.length) {
  console.log(`\n发现 ${problems.length} 个问题，修好再推送。\n`);
  process.exit(1);
}
console.log('\n✅ 没问题：所有引用都存在且大小写正确，没有 Node 专有 API 混进浏览器代码。');
console.log('   这个检查专治「本地能开、Pages 白屏」——多半就是大小写或裸导入。\n');
