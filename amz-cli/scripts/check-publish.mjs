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
{
  const raw = readFileSync(join(ROOT, 'tsconfig.json'), 'utf8');
  // 简单剥掉 // 注释后再解析(tsconfig 允许注释,JSON.parse 不允许)
  const json = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));
  if (json.compilerOptions?.removeComments !== true) {
    failures.push('tsconfig.json 没有开启 removeComments —— 源码注释会被打进 npm 包');
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
    lines.forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith('#!')) return; // shebang 是必须的
      if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) {
        failures.push(`${file.slice(ROOT.length + 1)}:${i + 1} 编译产物里出现注释:${t.slice(0, 60)}`);
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
  const targets = [];
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

  for (const file of [...new Set(targets)]) {
    const text = readFileSync(file, 'utf8');
    for (const word of words) {
      if (text.includes(word)) {
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
