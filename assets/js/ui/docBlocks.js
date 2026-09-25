/**
 * ui/docBlocks.js — 谱牒原文的版式还原
 * ---------------------------------------------------------------
 * 问题：doc 是**线性文本**，原谱里本为表格、注条、对联的内容，抽取后
 * 都变成了一个个平铺的段落。若一律按 <p> 直排，就会出现
 *      「凡字：士 昌 道 德 盛  裕 世 广 大 年」
 *      「位置：中 下 中 下 中  下 中 下 中 下」
 * 这类本应上下对齐的两行却各成一段、空格也被压成单空格，读者根本读不出
 * 「凡字 ↔ 位置」的对应关系。
 *
 * 解法：按行特征**分类还原版式**——凡字行、位置行、注条、对联、普通段落
 * 各归其位。原文一字不改，只还原它本来的样子。
 */

import { h } from '../core/dom.js';

const RE_FANZI = /^凡字[：:]/;
const RE_POS = /^位置[：:]/;
const RE_NOTE = /^(?:注[：:])?\s*([一二三四五六七八九十]|\d+)\s*[.、]/;
const RE_COUPLET = /^(上联|下联)[：:]/;
const RE_LABEL = /^([^：:]{1,10})[：:]\s*(.+)$/;

/** 把「士 昌 道 德 盛  裕 世 广 大 年」拆成等宽字格 */
function charCells(text) {
  return text.split(/\s+/).filter(Boolean);
}

/**
 * 逐段还原版式。返回可直接 append 的节点数组。
 * @param {string[]} paragraphs 原文段落
 */
export function docBlocks(paragraphs = []) {
  const out = [];
  let pending = null;      // 待与「位置」行配对的「凡字」行

  const flushFan = () => {
    if (!pending) return;
    const chars = pending.chars;
    const pos = pending.pos || [];
    out.push(
      h('div', { class: 'fanziblock' },
        h('div', { class: 'fanziblock__row' },
          h('span', { class: 'fanziblock__lab' }, '凡字'),
          ...chars.map((c) => h('span', { class: 'fanziblock__cell is-char' }, c))),
        h('div', { class: 'fanziblock__row' },
          h('span', { class: 'fanziblock__lab' }, '位置'),
          ...chars.map((_, i) => h('span', { class: 'fanziblock__cell' }, pos[i] || '—')))),
    );
    pending = null;
  };

  for (const raw of paragraphs) {
    const line = String(raw || '').trim();
    if (!line) continue;

    if (RE_FANZI.test(line)) {
      flushFan();
      pending = { chars: charCells(line.replace(RE_FANZI, '')), pos: [] };
      continue;
    }
    if (RE_POS.test(line) && pending) {
      pending.pos = charCells(line.replace(RE_POS, ''));
      flushFan();
      continue;
    }
    flushFan();

    if (RE_COUPLET.test(line)) {
      const m = line.match(RE_COUPLET);
      out.push(h('div', { class: 'couplet' },
        h('span', { class: 'couplet__lab' }, m[1]),
        h('span', { class: 'couplet__text' }, line.replace(RE_COUPLET, ''))));
      continue;
    }
    if (RE_NOTE.test(line)) {
      out.push(h('p', { class: 'doc-note' }, line));
      continue;
    }
    // 「说明：……」「注：……」等带标签的短行，按释义条目排
    if (line.length <= 40 && RE_LABEL.test(line) && !/[。！？]$/.test(line)) {
      const m = line.match(RE_LABEL);
      out.push(h('div', { class: 'doc-item' },
        h('span', { class: 'doc-item__k' }, m[1]),
        h('span', { class: 'doc-item__v' }, m[2])));
      continue;
    }
    out.push(h('p', {}, line));
  }
  flushFan();
  return out;
}

/**
 * 取一段适合做摘要的文字：优先取到第一个句号，避免截断在半句上。
 * @returns {string}
 */
export function excerpt(text = '', max = 120) {
  const t = String(text || '').trim();
  if (!t) return '';
  const cut = t.search(/[。！？]/);
  if (cut >= 0 && cut + 1 <= max) return t.slice(0, cut + 1);
  if (t.length <= max) return t;
  return t.slice(0, max).replace(/[，、；,;]$/, '') + '……';
}
