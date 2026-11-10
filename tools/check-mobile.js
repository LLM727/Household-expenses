/**
 * 手机适配自检：把「在电脑上一切正常、到手机上就难受」的几个常见坑写成检查。
 *
 * 为什么单独做一个工具：这一家三口是用手机记账的，台式机上根本看不出这些问题，
 * 而它们每一个都会让用户直接放弃使用：
 *   - 输入框字号小于 16px → iOS 一聚焦就自动放大整页，用户得手动缩回去；
 *   - 底部标签栏没用 safe-area → iPhone 上被小白条压住，点不到；
 *   - 100vh 在 iOS 上把地址栏算进高度 → 页面比屏幕长一截；
 *   - 删除按钮只有十几像素宽 → 手指点不准，误删或点不开；
 *   - 缺 touch-action → 点击有 300ms 延迟，手感发黏。
 *
 * 用法：node tools/check-mobile.js
 * 想在代码里直接查一份样式：import { checkCss } from './tools/check-mobile.js'
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/* 把样式表拆成一条条规则：{ selector, body }。
   选择器里可能夹着注释（那会把选择器切得乱七八糟），先去掉注释；
   选择器还可能带 :focus 伪类或 .catlist > li > 这种父级，所以后面按「整词」匹配。 */
function rules(source) {
  const out = [];
  const stripped = String(source).replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]+\{/g, '');
  for (const m of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    out.push({ selector: m[1].trim(), body: m[2] });
  }
  return out;
}

const px = (value) => {
  const m = /(-?[\d.]+)px/.exec(String(value || ''));
  return m ? Number(m[1]) : null;
};

/**
 * 检查一份样式表（和可选的页面 HTML），返回问题清单；空数组表示全部通过。
 * @param {string} css styles.css 的内容
 * @param {string} [html] index.html 的内容；不传就只查样式表
 * @returns {Array<{title:string, detail:string}>}
 */
export function checkCss(css, html) {
  const problems = [];
  const bad = (title, detail) => problems.push({ title, detail });
  const RULES = rules(css);

/* ---------------- 1. viewport ---------------- */

const viewport = html ? /<meta[^>]+name=["']viewport["'][^>]*content=["']([^"']+)["']/i.exec(html) : { 1: 'width=device-width, initial-scale=1, viewport-fit=cover' };
if (!viewport) {
  bad('缺 viewport', 'index.html 里没有 viewport meta，手机上会按桌面宽度缩放，字小得看不清');
} else {
  const content = viewport[1];
  if (!/width\s*=\s*device-width/i.test(content)) {
    bad('viewport 没写 width=device-width', `现在是 ${content}，页面不会按手机宽度排版`);
  }
  if (!/viewport-fit\s*=\s*cover/i.test(content)) {
    bad('viewport 缺 viewport-fit=cover', '刘海屏/小白条区域不会让出来，底部标签栏会被挡住');
  }

}

/* ---------------- 2. 输入框字号 ≥ 16px（iOS 自动放大的门槛） ---------------- */

let sawInputRule = false;
for (const rule of RULES) {
  if (!/(^|,|\s)(input|select|textarea)(\s|$|,|:|\.)/.test(rule.selector)) continue;
  const fs = /font-size\s*:\s*([^;]+)/.exec(rule.body);
  if (!fs) continue;
  sawInputRule = true;
  const size = px(fs[1]);
  if (size !== null && size < 16) {
    bad(
      '输入框字号小于 16px',
      `${rule.selector} 是 ${size}px。iOS Safari 一聚焦会自动放大整页，用户得手动缩回去；改成 16px 以上`,
    );
  }
}
if (!sawInputRule) bad('找不到输入框字号声明', 'styles.css 里没有给 input / textarea 定字号，请显式写 16px');

/* ---------------- 3. 底部固定栏要避开 iPhone 的小白条 ---------------- */

const fixedBottom = RULES.filter((r) => /position\s*:\s*fixed/.test(r.body) && /bottom\s*:\s*0/.test(r.body));
for (const r of fixedBottom) {
  if (!/env\(\s*safe-area-inset-bottom/.test(r.body)) {
    bad(
      '底部固定栏没让开 safe-area',
      `${r.selector} 用了 position:fixed; bottom:0，却没加 padding-bottom: env(safe-area-inset-bottom)——iPhone 上会被小白条压住`,
    );
  }
}

/* ---------------- 4. 100vh 要配 dvh 兜底 ---------------- */

for (const rule of RULES) {
  if (!/100vh/.test(rule.body)) continue;
  if (!/100dvh/.test(rule.body)) {
    bad(
      '只写了 100vh',
      `${rule.selector} 用了 100vh 但没有 dvh 兜底。iOS Safari 会把地址栏算进 100vh，页面比屏幕高一截`,
    );
  }
}
/* ---------------- 5. 小图标按钮的触摸区 ≥ 32px ---------------- */

for (const selector of ['.tx-del', '.btn.icon']) {
  const bare = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const found = RULES.filter((r) =>
    r.selector.split(',').some((s) => new RegExp(`(^|[\\s>])${bare}(?![\\w-])`).test(s.trim())),
  );
  if (!found.length) {
    bad('找不到按钮样式', `styles.css 里没有 ${selector} 的规则`);
    continue;
  }
  const body = found.map((r) => r.body).join(';');
  const w = px(/(?:^|;)\s*min-width\s*:\s*([^;]+)/.exec(body)?.[1]);
  const h = px(/(?:^|;)\s*min-height\s*:\s*([^;]+)/.exec(body)?.[1]);
  if (w === null || h === null || w < 32 || h < 32) {
    bad(
      '图标按钮的触摸区太小',
      `${selector} 是 ${w ?? '未设'}×${h ?? '未设'}px。手指点不准（还会误点到旁边的行），至少 32×32`,
    );
  }
}

/* ---------------- 6. 点击手感 ---------------- */

if (!/touch-action\s*:\s*manipulation/.test(css)) {
  bad('缺 touch-action', '按钮上没写 touch-action: manipulation，手机上点击会有 300ms 延迟，手感发黏');
}
if (!/-webkit-text-size-adjust\s*:\s*100%/.test(css)) {
  bad('-webkit-text-size-adjust', '缺 -webkit-text-size-adjust: 100%，手机横屏时字号会被自动放大');
}

  return problems;
}

if (process.argv[1]?.endsWith('check-mobile.js')) {
  const html = readFileSync(resolve(ROOT, 'index.html'), 'utf8');
  const css = readFileSync(resolve(ROOT, 'styles.css'), 'utf8');
  const problems = checkCss(css, html);
  console.log('检查手机适配（iOS / 安卓）\n');
  if (problems.length) {
    console.log(`❌ 发现 ${problems.length} 个问题：\n`);
    for (const p of problems) console.log(`  · ${p.title}：${p.detail}`);
    console.log('\n这些问题在电脑浏览器上看不出来，但手机上会直接难受。');
    process.exit(1);
  }
  console.log('✅ 没问题：手机适配检查全部通过。');
}