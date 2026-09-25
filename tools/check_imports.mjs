/**
 * check_imports.mjs — 模块图完整性检查（静态，不需要浏览器）
 * ---------------------------------------------------------------
 * 逐个读取 assets/js 下的模块，解析 import 语句，校验：
 *   1. 相对路径目标文件存在；
 *   2. 具名导入在目标模块的 export 中出现（含 `export { a, b }` 与 `export * `）；
 *   3. 默认导入要求目标存在 default 导出。
 * 目的：在无浏览器环境下提前捕获"改名漏改引用""路径写错"一类低级错误。
 *
 * 用法：node tools/check_imports.mjs
 */

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const JS_DIR = join(ROOT, 'assets', 'js');

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p));
    else if (/\.m?js$/.test(e.name)) out.push(p);
  }
  return out;
}

/** 提取模块的导出名集合 */
function collectExports(src) {
  const names = new Set();
  let hasDefault = /\bexport\s+default\b/.test(src);
  let hasStar = /\bexport\s*\*\s*from\b/.test(src);

  // export const/let/var/function/class A, B
  for (const m of src.matchAll(/\bexport\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(m[1]);
  }
  // export { a, b as c }
  for (const m of src.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const t = part.trim();
      if (!t) continue;
      const alias = t.split(/\s+as\s+/);
      const n = (alias[1] || alias[0]).trim();
      if (n) names.add(n);
      if (n === 'default') hasDefault = true;
    }
  }
  return { names, hasDefault, hasStar };
}

/** 提取模块的 import 需求 */
function collectImports(src) {
  const out = [];
  const re = /\bimport\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
  for (const m of src.matchAll(re)) {
    const clause = m[1].trim();
    const spec = m[2];
    const need = { spec, named: [], default: false, namespace: false };

    if (/^\*\s+as\s+/.test(clause)) need.namespace = true;
    else {
      const brace = clause.match(/\{([\s\S]*)\}/);
      const beforeBrace = clause.split('{')[0].replace(/,\s*$/, '').trim();
      if (beforeBrace) need.default = true;
      if (brace) {
        for (const part of brace[1].split(',')) {
          const t = part.trim();
          if (!t) continue;
          const src_ = t.split(/\s+as\s+/)[0].trim();
          if (src_) need.named.push(src_);
        }
      }
    }
    out.push(need);
  }
  return out;
}

const files = (await walk(JS_DIR)).sort();
const cache = new Map();
const srcOf = async (f) => {
  if (!cache.has(f)) cache.set(f, await readFile(f, 'utf8'));
  return cache.get(f);
};

let errors = 0, checked = 0;
const problems = [];

for (const file of files) {
  const src = await srcOf(file);
  const rel = relative(ROOT, file).replace(/\\/g, '/');

  for (const need of collectImports(src)) {
    if (!need.spec.startsWith('.')) continue; // 只校验站内相对导入
    checked++;
    const target = resolve(dirname(file), need.spec);
    if (!existsSync(target)) {
      problems.push(`[缺失文件] ${rel} → ${need.spec}`);
      errors++;
      continue;
    }
    const tsrc = await srcOf(target);
    const { names, hasDefault, hasStar } = collectExports(tsrc);
    if (hasStar) continue;

    const tRel = relative(ROOT, target).replace(/\\/g, '/');
    if (need.default && !hasDefault) {
      problems.push(`[缺 default] ${rel} ← ${tRel}`);
      errors++;
    }
    for (const n of need.named) {
      if (!names.has(n)) {
        problems.push(`[缺具名导出] ${rel} 需要 ${tRel} 的 \`${n}\``);
        errors++;
      }
    }
  }
}

console.log(`\n  模块图检查：扫描 ${files.length} 个模块，校验 ${checked} 条相对导入`);
if (problems.length) {
  console.log(`  发现 ${problems.length} 处问题：`);
  for (const p of problems) console.log(`    ✗ ${p}`);
  console.log(`\n  结果：失败\n`);
  process.exit(1);
}
console.log(`  结果：全部通过 ✓\n`);
