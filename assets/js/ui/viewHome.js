/**
 * ui/viewHome.js — 概览首页
 * ---------------------------------------------------------------
 * 设计原则（本次重构）：
 *   1. **进门即知有什么**：英雄区下方直接给出「快速检索」与六大功能入口，
 *      不让新用户在统计数字里找路。
 *   2. **检索前置**：找人是族谱最高频的动作，首页就给一个能用的搜索框，
 *      而不只是把人赶去「名录」页。
 *   3. **原文版式还原**：文献摘录走 docBlocks()，不再把凡字表、注条、对联
 *      压成平铺段落。
 *   4. **改造说明在明处**：软件化改造说明（孙智广）单列一节，作者与来由可查。
 */

import { h } from '../core/dom.js';
import { GEN_CHARS, GEN_LABELS } from '../core/schema.js';
import { computeStats, displayName, searchPersons } from '../domain/person.js';
import { branchStats } from '../domain/branch.js';
import { statCard, sectionHead, card, badge, bar, genCharTable, personPill } from './components.js';
import { docBlocks, excerpt } from './docBlocks.js';
import { AUTHOR_NOTE } from '../data/authorNote.js';

const CLOUDS = () => [
  h('span', { html: `<svg width="120" height="26" viewBox="0 0 120 26" fill="none"><path d="M2 20c7-10 19-10 25-3 4 5 12 5 16 0 6-7 17-7 22 2" stroke="currentColor" stroke-opacity="0.28" stroke-width="1.4" stroke-linecap="round"/></svg>` }),
  h('span', { html: `<svg width="92" height="22" viewBox="0 0 92 22" fill="none"><path d="M2 17c6-8 15-8 20-2 3 4 9 4 13 0 4-5 13-5 17 1" stroke="currentColor" stroke-opacity="0.2" stroke-width="1.4" stroke-linecap="round"/></svg>` }),
];

/* ── 功能入口图标（内联 SVG，无外部依赖） ───────────────── */
const ICONS = {
  chart: '<path d="M4 26h24M12 26V14M20 26V14M12 14V6M20 14V6M8 10h16" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  explore: '<circle cx="14" cy="14" r="8" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M20 20l6 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  docs: '<path d="M7 5h11l5 5v16H7z" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linejoin="round"/><path d="M18 5v5h5M11 15h9M11 19h9" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round"/>',
  validate: '<path d="M6 6h20v20H6z" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linejoin="round"/><path d="M10 15l4 4 8-8" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  genchar: '<path d="M6 10h20M6 16h20M6 22h20" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="16" cy="5" r="2" fill="currentColor"/>',
  admin: '<circle cx="16" cy="11" r="4.5" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M7 25c2-5 5-7 9-7s7 2 9 7" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/>',
};

/** 功能入口卡：图标 + 名称 + 一句话说明 + 右箭头 */
function entryCard({ icon, label, desc, meta, onClick }) {
  return h('button', { class: 'entry', onClick },
    h('span', { class: 'entry__icon', html: `<svg viewBox="0 0 32 32" aria-hidden="true">${ICONS[icon] || ''}</svg>` }),
    h('span', { class: 'entry__text' },
      h('span', { class: 'entry__label' }, label),
      h('span', { class: 'entry__desc' }, desc)),
    meta ? h('span', { class: 'entry__meta' }, meta) : null,
    h('span', { class: 'entry__go', 'aria-hidden': 'true' }, '›'));
}

export function renderHome(store, { seed, onPick, onNavigate }) {
  const persons = store.persons;
  const stats = computeStats(persons);
  const branches = branchStats(persons);
  const report = seed.buildReport;
  const root = h('div', { class: 'view' });

  /* ── 英雄区 ─────────────────────────────────────────── */
  const preface = seed.intro?.sections?.find((s) => s.id === 'PREFACE');
  const lead = excerpt(preface?.paragraphs?.[0] || '', 132);

  root.appendChild(h('section', { class: 'hero' },
    h('div', { class: 'moon' }),
    h('div', { class: 'hero__clouds' }, ...CLOUDS()),
    h('div', { class: 'hero__inner' },
      h('div', { class: 'hero__eyebrow' }, 'Mid-Autumn · Genealogy'),
      h('h1', {}, '孙氏族谱'),
      h('p', { class: 'hero__lead' }, lead),
      h('div', { class: 'hero__meta' },
        badge('一世祖文友公 · 自山东迁辽东', 'gold'),
        badge(`现存 ${stats.maxGen} 世`, 'jade'),
        badge('六大支系', 'cinnabar'),
        badge(`${stats.total} 人`, 'muted')))));

  /* ── 快速检索（首页直接可用） ────────────────────────── */
  const resultBox = h('div', { class: 'quickfind__results' });
  const input = h('input', {
    class: 'input input--search quickfind__input',
    type: 'search',
    placeholder: '输入谱名、配偶名或原谱单元格（如 I276）…',
    'aria-label': '检索族人',
    onInput: (e) => {
      const q = (e.target.value || '').trim();
      resultBox.textContent = '';
      if (!q) {
        resultBox.hidden = true;
        return;
      }
      const hits = searchPersons(persons, q).slice(0, 8);
      resultBox.hidden = false;
      if (!hits.length) {
        resultBox.appendChild(h('div', { class: 'quickfind__empty' }, '未找到匹配的族人'));
        return;
      }
      for (const p of hits) {
        const f = p.fatherId ? persons.find((x) => x.id === p.fatherId) : null;
        resultBox.appendChild(h('button', { class: 'quickfind__hit', onClick: () => onPick(p.id) },
          h('span', { class: 'quickfind__name' }, displayName(p)),
          h('span', { class: 'quickfind__sub' },
            `${GEN_LABELS[p.gen]}　${p.branchKey ? p.branchKey + '支' : ''}`
            + (f ? `　父：${displayName(f)}` : ''))));
      }
      if (searchPersons(persons, q).length > 8) {
        resultBox.appendChild(h('button', {
          class: 'quickfind__more',
          onClick: () => onNavigate('explore', { q }),
        }, `查看全部 ${searchPersons(persons, q).length} 条结果 →`));
      }
    },
  });
  resultBox.hidden = true;

  root.appendChild(h('section', { class: 'quickfind' },
    h('div', { class: 'quickfind__bar' },
      h('span', { class: 'quickfind__icon', html: '<svg viewBox="0 0 32 32" aria-hidden="true">' + ICONS.explore + '</svg>' }),
      input),
    resultBox,
    h('p', { class: 'quickfind__hint' },
      '共收录 ', h('strong', {}, String(stats.total)), ' 人　·　'
      + '按 ', h('kbd', { class: 'mono' }, '/'), ' 可随时唤起检索')));

  /* ── 功能入口 ───────────────────────────────────────── */
  root.appendChild(sectionHead('从这里开始'));
  root.appendChild(h('div', { class: 'grid grid--3' },
    entryCard({
      icon: 'chart', label: '谱系图', desc: '纵向世系树，含配偶；可折叠、缩放、平移',
      meta: `${stats.maxGen} 世`, onClick: () => onNavigate('chart'),
    }),
    entryCard({
      icon: 'explore', label: '名录检索', desc: '按世代、支系筛选，列表与世系树双模式',
      meta: `${stats.total} 人`, onClick: () => onNavigate('explore'),
    }),
    entryCard({
      icon: 'docs', label: '谱牒文献', desc: '前言、编后话、农垦考与三次修订说明原文',
      meta: '4,617 字', onClick: () => onNavigate('docs'),
    }),
    entryCard({
      icon: 'validate', label: '校验中心', desc: '独立交叉校验与待复核清单，可跳转原谱',
      meta: `${report.totals.issueTotal} 项`, onClick: () => onNavigate('validate'),
    }),
    entryCard({
      icon: 'genchar', label: '二十辈凡字', desc: '士仁公、道公公所定凡字与位置',
      meta: '20 字', onClick: () => onNavigate('docs'),
    }),
    entryCard({
      icon: 'admin', label: '权限与数据', desc: '角色切换、导入导出、审计日志',
      meta: '四角色', onClick: () => onNavigate('admin'),
    })));

  /* ── 谱系概览 ───────────────────────────────────────── */
  root.appendChild(sectionHead('谱系概览'));
  root.appendChild(h('div', { class: 'grid grid--4' },
    statCard({ label: '收录人物', value: stats.total, unit: '人', hint: `男丁 ${stats.males} · 配偶 ${stats.spouses}` }),
    statCard({ label: '世代跨度', value: stats.maxGen, unit: '世', hint: `一世祖至 ${GEN_LABELS[stats.maxGen]}` }),
    statCard({ label: '支系', value: branches.length, unit: '支', hint: '仁、礼、义、智、斌、吉' }),
    statCard({ label: '平均子女', value: stats.avgChildren, unit: '人', hint: `无嗣者 ${stats.leaves} 人` })));

  /* ── 六大支系 ───────────────────────────────────────── */
  root.appendChild(sectionHead('六大支系',
    h('span', { class: 't-sm t-faint' }, '按《前言》「以下按仁、义、礼、智、斌、吉六大支分写」')));
  const maxCount = Math.max(...branches.map((b) => b.personCount), 1);
  root.appendChild(h('div', { class: 'grid grid--3' },
    ...branches.map((b) => h('div', { class: 'card' },
      h('div', { class: 'card__body' },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px' } },
          h('h3', { class: 't-serif', style: { fontSize: '1.05rem' } }, b.name),
          h('span', { style: { flex: 1 } }),
          badge(`${b.personCount} 人`, b.tone === 'muted' ? 'muted' : b.tone)),
        h('p', { class: 't-sm t-dim', style: { margin: '6px 0 10px' } }, b.desc),
        bar((b.personCount / maxCount) * 100),
        h('div', { class: 't-xs t-faint', style: { marginTop: '6px' } },
          `${GEN_LABELS[b.minGen]} — ${GEN_LABELS[b.maxGen]}　·　含配偶共 ${b.totalWithSpouses} 人`),
        h('div', { class: 'btn-row', style: { marginTop: '10px' } },
          h('button', {
            class: 'btn btn--sm',
            onClick: () => onNavigate('explore', { branchId: b.id }),
          }, '查看世系')))))));

  /* ── 二十辈凡字 ─────────────────────────────────────── */
  root.appendChild(sectionHead('二十辈凡字',
    h('span', { class: 't-sm t-faint' }, '出自《孙氏族谱前言》注 2、注 3')));
  root.appendChild(h('div', { class: 'grid grid--2' },
    card('前十字（士仁公所定 · 第 6–15 世）', genCharTable(GEN_CHARS.slice(0, 10))),
    card('后十字（道公公所定 · 第 16–25 世）', genCharTable(GEN_CHARS.slice(10)))));

  /* ── 软件化改造说明（作者：孙智广） ───────────────────── */
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
      h('div', { class: 'grid grid--4 authorcard__stats' },
        ...an.highlights.map((x) => statCard({ label: x.k, value: x.v, unit: x.u, hint: x.d }))),
      h('div', { class: 'doc-body', style: { marginTop: '14px' } },
        ...an.paragraphs.map((p) => h('p', {}, p))),
      h('div', { class: 'doc-sign' },
        ...an.signature.map((s, i) => h('div', { class: i === 0 ? 'name' : 'date' }, s))))));

  /* ── 谱牒文献速览（版式已还原） ──────────────────────── */
  root.appendChild(sectionHead('谱牒文献',
    h('button', { class: 'btn btn--sm', onClick: () => onNavigate('docs') }, '全部文献')));
  root.appendChild(h('div', { class: 'grid grid--2' },
    card('孙氏族谱前言', [
      h('div', { class: 'doc-body' },
        h('p', { class: 't-serif' }, excerpt(preface?.paragraphs?.[0] || '', 190))),
      h('div', { class: 'doc-sign' },
        h('div', { class: 'name' }, '九世孙　孙金德'),
        h('div', { class: 'date' }, '一九八三年七月一日')),
    ]),
    card('凡字与注记（原文版式）', docBlocks(
      (seed.intro?.sections?.find((s) => s.id === 'GEN_CHARS')?.paragraphs || []).slice(0, 6)))));

  /* ── 独立交叉校验 ───────────────────────────────────── */
  const vf = seed.verification;
  if (vf?.summary) {
    const failed = vf.summary.failed || 0;
    root.appendChild(sectionHead('独立交叉校验',
      h('span', { class: 't-sm t-faint' }, '校验器与建模器不共享代码，仅读原谱逐格转录独立重算')));
    root.appendChild(h('div', { class: 'grid grid--4' },
      statCard({ label: '校验项', value: vf.summary.total, unit: '项', hint: 'C01–C12 逐项独立重算' }),
      statCard({ label: '通过', value: vf.summary.passed, unit: '项', hint: failed ? `未通过 ${failed} 项` : '全部通过' }),
      statCard({ label: '已知留白', value: vf.summary.knownGapTotal, unit: '处', hint: '原谱本身未记，如实标注而不猜测' }),
      statCard({ label: '核验出处', value: '2,156', unit: '条', hint: '每条出处回溯至原谱单元格' })));
    root.appendChild(card(null, [
      h('p', { class: 't-sm t-dim', style: { marginBottom: '10px' } }, vf.method),
      h('div', { class: 'table-wrap' },
        h('table', { class: 'tbl' },
          h('thead', {}, h('tr', {},
            h('th', {}, '编号'), h('th', {}, '校验项'), h('th', {}, '结果'), h('th', {}, '独立重算摘要'))),
          h('tbody', {}, ...vf.checks.map((c) => h('tr', { style: { cursor: 'default' } },
            h('td', { class: 'mono t-xs' }, c.code),
            h('td', {}, c.title),
            h('td', {}, c.pass
              ? badge(c.knownGapCount ? `通过（${c.knownGapCount} 处留白）` : '通过', c.knownGapCount ? 'clay' : 'jade')
              : badge(`未通过 ${c.problemCount}`, 'cinnabar')),
            h('td', { class: 't-xs t-dim' }, c.detail || '—')))))),
    ]));
  }

  /* ── 数据声明 + 来源指纹 ─────────────────────────────── */
  root.appendChild(card(null, [
    h('h3', { class: 't-serif', style: { marginBottom: '6px' } }, '数据使用声明'),
    h('p', { class: 't-sm t-dim', style: { marginBottom: '8px' } }, seed.meta.disclaimer),
    h('p', { class: 't-sm t-dim', style: { marginBottom: '10px' } },
      '本站为静态站点：全部数据在浏览器本地存储与编辑，不上传服务器。任何修改都会记录在审计日志中，'
      + '并可通过「权限与数据」导出为 JSON 归档或与他人交换。'),
    h('div', { class: 'field__label', style: { marginBottom: '6px' } }, '源文件指纹（SHA-256）'),
    h('p', { class: 't-xs t-faint', style: { marginBottom: '6px' } },
      '任一台机器对同一份原始文件重算 SHA-256 都会得到同一串字符；若与下方不符，说明所依据的原始资料已不是本谱所用版本。'),
    h('div', { class: 'refs' }, ...(seed.meta.sourceManifest || []).map((x) => h('span', {
      class: 'ref-cell', title: `${x.file} · ${x.bytes} 字节 · SHA-256 ${x.sha256}`,
    }, `${String(x.file).split(/[\\/]/).pop()} · ${(x.sha256 || '').slice(0, 12)}…`))),
    h('div', { class: 'table-wrap', style: { marginTop: '10px' } },
      h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, h('th', {}, '原始资料'), h('th', {}, '字节'), h('th', {}, 'SHA-256 指纹'))),
        h('tbody', {}, ...(seed.meta.sourceManifest || []).map((x) => h('tr', { style: { cursor: 'default' } },
          h('td', {}, String(x.file).split(/[\\/]/).pop()),
          h('td', { class: 'mono t-xs' }, (x.bytes || 0).toLocaleString('zh-CN')),
          h('td', { class: 'mono t-xs' }, x.sha256)))))),
  ]));

  return root;
}
