/**
 * ui/viewDocs.js — 谱牒文献（简介 / 前言 / 编后话 / 农垦考 / 修订说明）
 */

import { h } from '../core/dom.js';
import { GEN_CHARS } from '../core/schema.js';
import { badge, card, genCharTable, sectionHead } from './components.js';
import { docBlocks, excerpt } from './docBlocks.js';
import { AUTHOR_NOTE } from '../data/authorNote.js';

export function renderDocs(seed, { onNavigate }) {
  const intro = seed.intro;
  const root = h('div', { class: 'view' });

  root.appendChild(h('section', { class: 'hero', style: { paddingBottom: '24px' } },
    h('div', { class: 'moon', style: { opacity: '0.34' } }),
    h('div', { class: 'hero__inner' },
      h('div', { class: 'hero__eyebrow' }, 'Documents'),
      h('h1', { style: { fontSize: '2rem' } }, '谱牒文献'),
      h('p', { class: 'hero__lead' }, '《孙氏族谱》正文原貌转录，含前言、编后话、农垦考与三次修订说明。'),
      h('div', { class: 'hero__meta' },
        badge(`正文 ${intro.meta.charCount} 字`, 'gold'),
        badge(`段落 ${intro.meta.paragraphCount} 段`, 'jade'),
        badge('转录自 孙氏族谱1.doc', 'muted')))));

  /* 目录
     原谱目录是**两列表格**，doc 抽取后摊平成一条线性序列：
       [序号, 内容名称, 页码, 一, 孙氏族谱前言, 二, 当代中国的农垦, …, （一）…, 孙氏族谱前言]
     直接逐条直排会出现「序号 / 内容名称 / 页码」混入正文、末尾还多出一个重复的
     「孙氏族谱前言」。此处按「序号 → 标题」重新配对，子目缩进，并去掉表头与重复项。 */
  const toc = intro.sections.find((s) => s.id === 'TOC');
  if (toc) {
    const HEAD = new Set(['序号', '内容名称', '页码']);
    const NUM = /^[一二三四五六七八九十]+$/;
    const SUB = /^（[一二三四五六七八九十]+）/;
    const rows = [];
    const seen = new Set();
    let pending = null;
    for (const raw of toc.items || []) {
      const x = String(raw || '').trim();
      if (!x || HEAD.has(x)) continue;
      if (NUM.test(x)) { pending = x; continue; }
      if (seen.has(x)) continue;          // 表尾重复项
      seen.add(x);
      rows.push({ num: pending, title: x, sub: SUB.test(x) });
      pending = null;
    }
    root.appendChild(sectionHead('原谱目录'));
    root.appendChild(card(null, h('ol', { class: 'toc-list' },
      ...rows.map((r) => h('li', { class: r.sub ? 'is-sub' : '' },
        r.num ? h('span', { class: 'toc-list__num' }, r.num) : null,
        h('span', { class: 'toc-list__title' }, r.title))))));
  }

  /* 版本沿革 */
  const colophon = intro.sections.find((s) => s.id === 'COLOPHON');
  if (colophon) {
    root.appendChild(sectionHead('版本沿革'));
    root.appendChild(card(null, h('div', { class: 'doc-body' },
      ...colophon.paragraphs.map((p) => h('p', {}, p))),
      { foot: `编辑者：${intro.cover.editors.join('　·　')}` }));
  }

  /* 正文各节 */
  for (const sec of intro.sections) {
    if (['TOC', 'COLOPHON'].includes(sec.id)) continue;
    if (sec.kind === 'toc') continue;
    // 原文里本为表格/注条/对联的内容，抽取后成了平铺段落；
    // 经 docBlocks() 分类还原版式，读得出「凡字 ↔ 位置」的对应关系。
    const body = h('div', { class: 'doc-body' }, ...docBlocks(sec.paragraphs || []));
    for (const n of sec.notes || []) body.appendChild(h('div', { class: 'quote' }, n));
    if (sec.signature?.length) {
      body.appendChild(h('div', { class: 'doc-sign' },
        ...sec.signature.map((s, i) => h('div', { class: i === 0 ? 'name' : 'date' }, s))));
    }
    if (sec.footnote?.length) {
      body.appendChild(h('div', { class: 't-xs t-faint', style: { marginTop: '14px' } },
        ...sec.footnote.map((f) => h('div', {}, `※ ${f}`))));
    }
    root.appendChild(sectionHead(sec.title));
    root.appendChild(card(null, body));
  }

  /* 软件化改造说明（作者：孙智广）—— 与纸质谱牒并列，交代本次数字化的来由 */
  const an = AUTHOR_NOTE;
  root.appendChild(sectionHead('软件化改造说明',
    h('span', { class: 't-sm t-faint' }, `${an.name} 撰　·　${an.date}`)));
  root.appendChild(h('div', { class: 'card authorcard' },
    h('div', { class: 'card__body' },
      h('div', { class: 'authorcard__head' },
        h('span', { class: 'authorcard__seal', 'aria-hidden': 'true' }, '智广'),
        h('div', {},
          h('h3', { class: 't-serif', style: { fontSize: '1.1rem', marginBottom: '2px' } }, an.title),
          h('div', { class: 't-xs t-faint' },
            `${an.name}　·　谱名「${an.谱名}」　·　${an.世代}　·　${an.支系}`))),
      h('div', { class: 'doc-body', style: { marginTop: '12px' } },
        ...an.paragraphs.map((p) => h('p', {}, p))),
      h('div', { class: 'doc-sign' },
        ...an.signature.map((s, i) => h('div', { class: i === 0 ? 'name' : 'date' }, s))))));

  /* 凡字表 */
  root.appendChild(sectionHead('二十辈凡字'));
  root.appendChild(h('div', { class: 'grid grid--2' },
    card('士仁公所定十字（第 6–15 世）', genCharTable(GEN_CHARS.slice(0, 10))),
    card('道公公所定十字（第 16–25 世）', genCharTable(GEN_CHARS.slice(10)))));
  root.appendChild(h('div', { class: 'quote', style: { marginTop: '12px' } },
    '《前言》注 2：「排辈起名凡字：从士字辈起，每辈凡一字。凡字位置或在中或在下。」',
    h('br'),
    '《编后话》：「盛字辈的有的写圣贤的圣也有的写胜利的胜，裕字辈的有写玉石的玉。'
    + '我在续写族谱时，一律写盛和裕……要求孙氏后代按照先祖所定的原字书写自己的名字。」'));

  /* 溯源 */
  root.appendChild(sectionHead('转录溯源'));
  root.appendChild(card(null, [
    h('dl', { class: 'kv' },
      h('dt', {}, '源文件'), h('dd', { class: 'mono t-xs' }, intro.meta.source),
      h('dt', {}, '文件格式'), h('dd', {}, 'Word 97–2003（OLE2 复合文档）'),
      h('dt', {}, '抽取方式'), h('dd', {}, '按 MS-DOC 规范解析 FIB → Clx → PlcPcd 分片表，逐片还原正文（含图片占位、域、批注标记）'),
      h('dt', {}, '抽取工具'), h('dd', { class: 'mono t-xs' }, 'tools/extract_doc.py'),
      h('dt', {}, '中间产物'), h('dd', { class: 'mono t-xs' }, 'data/source/doc-text.json'),
      h('dt', {}, '指纹'), h('dd', { class: 'mono t-xs' }, (intro.meta.sha256 || '').slice(0, 32) + '…'),
      h('dt', {}, '抽取时间'), h('dd', { class: 't-xs' }, intro.meta.extractedAt)),
    h('p', { class: 't-sm t-dim', style: { marginTop: '12px', marginBottom: 0 } },
      '为保持史料原貌，正文中的生僻字注音（如「愆（qian 一声 耽误的意思）」）、'
      + '误字与口语化表述一律照录，未作校改；如需订正，请在「数据管理」中导出后另行标注。'),
  ]));

  return root;
}
