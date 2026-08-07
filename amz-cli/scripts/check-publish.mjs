// 发布前自检 —— 在 prepublishOnly 里跑,不通过就中止发布。
//
// npm 包一旦发出去就收不回来:超过 72 小时、或周下载量超过阈值,
// 就不再允许自助 unpublish,而且各种镜像早已抓走。所以把关只能放在发布之前。
//
// 检查两件事:
//   1. 编译产物不含注释。源码注释是写给维护者的,没有必要随包分发;
//      只要 dist 里一行注释都没有,就不存在"某句注释不该发出去"的问题。
//   2. 发布内容不含内部词表里的词(词表放在 local-delivery/,不入库)。
//      词表不存在时跳过这一项。
//
// 用法:npm run check:publish(npm publish 会自动跑)

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = process.cwd();
const failures = [];

// ── 1. tsconfig 必须开 removeComments ────────────────────────────

// 剥掉 JSONC 里的 // 与 /* */ 注释(tsconfig 允许注释,JSON.parse 不允许)。
// 逐字符扫描并跟踪字符串状态:行尾注释、多行注释都能剥,字符串里的 "//"(如 URL)不误伤。
function stripJsonComments(text) {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (ch === '\n') { inLine = false; out += ch; }
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') { inBlock = false; i++; }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === '\\') { out += next ?? ''; i++; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === '/' && next === '/') { inLine = true; i++; continue; }
    if (ch === '/' && next === '*') { inBlock = true; i++; continue; }
    out += ch;
  }
  return out;
}

{
  const raw = readFileSync(join(ROOT, 'tsconfig.json'), 'utf8');
  try {
    const json = JSON.parse(stripJsonComments(raw));
    if (json.compilerOptions?.removeComments !== true) {
      failures.push('tsconfig.json 没有开启 removeComments —— 源码注释会被打进 npm 包');
    }
  } catch (err) {
    failures.push(`tsconfig.json 剥注释后仍解析失败,请检查语法:${err?.message ?? err}`);
  }
}

// ── 2. dist 里不得有整行注释 ─────────────────────────────────────
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (extname(p) === '.js') out.push(p);
  }
  return out;
}

const distDir = join(ROOT, 'dist');
if (!existsSync(distDir)) {
  failures.push('dist/ 不存在 —— 先跑 npm run build');
} else {
  for (const file of walk(distDir)) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    // `*` 开头的行只有处于 /* … */ 注释块内部才算注释:
    // 编译产物里模板字符串的续行也可能以 `*` 开头,一律当注释会误报。
    let inBlockComment = false;
    lines.forEach((line, i) => {
      const t = line.trim();
      const report = () =>
        failures.push(`${file.slice(ROOT.length + 1)}:${i + 1} 编译产物里出现注释:${t.slice(0, 60)}`);
      if (inBlockComment) {
        report();
        if (t.includes('*/')) inBlockComment = false;
        return;
      }
      if (t.startsWith('#!')) return; // shebang 是必须的
      if (t.startsWith('//')) { report(); return; }
      if (t.startsWith('/*')) {
        report();
        if (!t.includes('*/')) inBlockComment = true;
      }
    });
  }
}

// ── 3. 内部词表(可选,词表本身不入库)───────────────────────────────
const blocklistPath = join(ROOT, 'local-delivery', 'publish-blocklist.txt');
if (existsSync(blocklistPath)) {
  const words = readFileSync(blocklistPath, 'utf8')
    .split(/\r?\n/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0 && !w.startsWith('#'));

  // package.json 的 files 字段决定了发布内容;这里检查其中的文本文件
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  // package.json 本身被 npm 强制随包发布(不受 files 控制),也必须扫
  const targets = [join(ROOT, 'package.json')];
  for (const entry of pkg.files ?? []) {
    const p = join(ROOT, entry.replace(/\/$/, ''));
    if (!existsSync(p)) continue;
    if (statSync(p).isDirectory()) {
      for (const f of walk(p)) targets.push(f);
      // 目录里的非 .js 文本(如 skills/*.md)也要看
      const stack = [p];
      while (stack.length) {
        const d = stack.pop();
        for (const name of readdirSync(d)) {
          const q = join(d, name);
          if (statSync(q).isDirectory()) stack.push(q);
          else if (/\.(md|json|txt|example)$/.test(name)) targets.push(q);
        }
      }
    } else {
      targets.push(p);
    }
  }

  // 词表匹配不区分大小写:店铺名/内部代号换个大小写照样是泄漏
  for (const file of [...new Set(targets)]) {
    const text = readFileSync(file, 'utf8').toLowerCase();
    for (const word of words) {
      if (text.includes(word.toLowerCase())) {
        failures.push(`${file.slice(ROOT.length + 1)} 含内部词表中的词:「${word}」`);
      }
    }
  }
}

// ── 结果 ─────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error('\n发布前自检未通过,已中止:\n');
  for (const f of failures) console.error('  ✗ ' + f);
  console.error('\n修好后重试。npm 包发出去就撤不回来了。\n');
  process.exit(1);
}
console.log('发布前自检通过');
