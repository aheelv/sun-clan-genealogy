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

import { h, modal } from '../core/dom.js';
import { GEN_CHARS, GEN_LABELS } from '../core/schema.js';
import { computeStats, displayName, searchPersons } from '../domain/person.js';
import { branchStats } from '../domain/branch.js';
import { statCard, sectionHead, card, badge, bar, genCharTable, personPill, pageJump } from './components.js';
import { docBlocks, excerpt } from './docBlocks.js';
import { VIEW_ICONS } from './viewMeta.js';
import { AUTHOR_NOTE } from '../data/authorNote.js';

/**
 * 「原籍与迁徙」正文取《孙氏族谱前言》前三段（原谱第 35–37 段）：
 *   P0 原籍山东登州府文登县孙家洼 · 文友公流落复州三道嘴子
 *   P1 与岛外北滩亮子屯曲姓女结亲 · 迁居孙家沟子 · 称海北始祖
 *   P2 二世祖分居 · 智、斌、吉诸公北迁被挽留
 * 三段同属「从哪来、怎么落脚」一条线，故一并作为原籍介绍的完整正文。
 * ⚠ 此处为**硬编码段落下标**，依赖 build_data.py 的 PREFACE pick([35…42])；
 *   若前言段落顺序调整，必须同步改这里，否则会静默取错段落。
 */
const ORIGIN_PARAS = [0, 1, 2];

/**
 * 取前若干句作摘要。
 *
 * 不能用 docBlocks 的 `excerpt()`：它遇到第一个句号就收尾，而《前言》开篇
 * 第一句只是「我孙氏（汉族）原籍山东省登州府文登县孙家洼（小地名南桥子白果树屯）。」
 * ——原籍介绍因此只剩一行，正是「内容过短」的成因。这里按句累加，
 * 既保住可读的断句，又能把迁徙经过一并交代。
 */
function leadOf(text, { sentences = 4, maxChars = 170 } = {}) {
  const t = String(text || '').trim();
  if (!t) return '';
  const parts = t.match(/[^。！？]*[。！？]/g) || [t];
  let out = '';
  for (let i = 0; i < Math.min(sentences, parts.length); i += 1) {
    if (out && out.length + parts[i].length > maxChars) break;
    out += parts[i];
  }
  return out || parts[0];
}

const CLOUDS = () => [
  h('span', { html: `<svg width="120" height="26" viewBox="0 0 120 26" fill="none"><path d="M2 20c7-10 19-10 25-3 4 5 12 5 16 0 6-7 17-7 22 2" stroke="currentColor" stroke-opacity="0.28" stroke-width="1.4" stroke-linecap="round"/></svg>` }),
  h('span', { html: `<svg width="92" height="22" viewBox="0 0 92 22" fill="none"><path d="M2 17c6-8 15-8 20-2 3 4 9 4 13 0 4-5 13-5 17 1" stroke="currentColor" stroke-opacity="0.2" stroke-width="1.4" stroke-linecap="round"/></svg>` }),
];

/* ── 功能入口图标：与导航共用 ui/viewMeta.js 的一份（不再本地重复定义） ── */
const ICONS = VIEW_ICONS;

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

/* ── 使用说明 ───────────────────────────────────────────── */

/**
 * 各模块使用说明。
 * 与界面一一对应：改模块名或交互时同步改这里，避免说明与实物脱节。
 */
const GUIDE = [
  {
    icon: 'home', title: '概览（默认落点）',
    items: [
      '进门先看这一页：收录人数、世代跨度、六大支系规模与平均子女数一目了然。',
      '英雄区下方是「快速检索」：输入谱名、配偶名或原谱单元格编号（如 I276），点击结果即可跳到该人档案。',
      '「原籍与迁徙」默认只显示摘要，点「展开原籍全文」可读《前言》中关于原籍与迁居的完整三段原文。',
      '下方依次是六大支系、二十辈凡字、软件化改造说明与谱牒文献速览，点击支系卡可带筛选跳转到名录。',
    ],
  },
  {
    icon: 'chart', title: '谱系图',
    items: [
      '本站主视图：以图形呈现世系，而非文字列表。世代自上而下铺开，实线为父系主干，虚线为配偶。',
      '工具条可切换「根人物」（一世祖或六大支系祖）、「展开层数」（2 代至全部）、「方向」（纵向／横向）与「是否显示配偶」。',
      '点击节点 → 右侧显示该人档案；双击节点 → 以该人为根重新展开；节点下方的 ＋/− 折叠或展开该支。',
      '缩放平移：滚轮缩放（以指针为中心）、按住拖拽平移；手机为双指捏合缩放、单指拖动平移。放大后图形超出画布时，状态栏会提示「可拖拽平移查看」。',
      '节点描边为虚线者，表示父子关系来自规则推导（待核），须在「校验中心」复核后方可视为定论。',
      '右上角「适应」按钮可随时回到「整图刚好放得下」的视角。',
    ],
  },
  {
    icon: 'explore', title: '名录',
    items: [
      '默认以「世系树」呈现并展开全部世代；点顶部「列表／世系树」可切换视图，列表更适合逐条翻阅与比对。',
      '世系树中：点击节点前的 ＋/− 折叠或展开该支，虚线框为配偶；工具条提供「全部展开」「展开至三世」「全部折叠」。',
      '筛选条可按「世代」「支系」多选过滤，并可勾选「仅看推导待核」只看待复核人物；排序支持世代、姓名、子女数、配偶数。',
      '在检索框输入关键词即自动切到列表视图并过滤结果，命中数显示在右上角。',
      '点任一人 → 右侧显示完整档案：世系路径、父母、配偶、子女、过继关系、旁注与原谱出处，并按当前角色给出编辑／添子／添配／删除按钮。',
    ],
  },
  {
    icon: 'docs', title: '文献',
    items: [
      '《孙氏族谱前言》《编后话》《农垦考》与三次修订说明的原文，按原谱版式还原（注条、凡字表、对联不再压平）。',
      '每段都可回溯到原谱页码；凡字与注记一节给出二十辈凡字及其在姓名中的位置规则。',
    ],
  },
  {
    icon: 'validate', title: '校验中心',
    items: [
      '构建期校验（V001–V019）与独立交叉校验（C01–C12）的分项结果，含每项的问题数与明细清单。',
      '「待复核清单」集中列出全部由规则推导而来的父子关系，可一键跳转到原谱对应单元格核对。',
      '校验只报告、不改数据：原谱留白处如实标注为待考，不做臆断补全。',
    ],
  },
  {
    icon: 'admin', title: '权限与数据',
    items: [
      '四角色 RBAC：「访客」只读；「编修」可增改与导出；「族老」可删改、导入并查阅审计日志；「管理员」拥有全部权限。',
      '切换角色需口令：访客免口令，切到其他角色须输入口令，通过后本会话内有效，刷新页面即重新上锁。',
      '数据管理：导出 JSON 归档、导入覆盖、重置为原始转录。导入与重置不可撤销，请先导出备份。',
      '变更审计：所有增删改与导入／重置都会留痕（操作人、时间、修订号）。',
    ],
  },
];

/** 使用说明弹窗：把各模块的用法讲清楚，而不是把用户推去猜 */
function openGuide() {
  const body = h('div', { class: 'guide' },
    h('p', { class: 't-sm t-dim' },
      '本站把《孙氏族谱》的世系图表与谱牒文献转录、建模为结构化数据，'
      + '以下按模块说明用法。所有数据都保存在你自己的浏览器里，不会上传服务器。'),
    ...GUIDE.map((g) => h('section', { class: 'guide__item' },
      h('h4', { class: 'guide__title' },
        h('span', { class: 'guide__icon', html: `<svg viewBox="0 0 32 32" aria-hidden="true">${ICONS[g.icon] || ''}</svg>` }),
        g.title),
      h('ul', { class: 'guide__list' }, ...g.items.map((t) => h('li', {}, t))))),
    h('section', { class: 'guide__item' },
      h('h4', { class: 'guide__title' },
        h('span', { class: 'guide__icon', html: `<svg viewBox="0 0 32 32" aria-hidden="true">${ICONS.genchar}</svg>` }),
        '快捷键与提示'),
      h('ul', { class: 'guide__list' },
        h('li', {}, '按 ', h('kbd', { class: 'mono' }, '/'), ' 随时唤起检索；按 ', h('kbd', { class: 'mono' }, 'g'), ' 直达谱系图。'),
        h('li', {}, '顶栏右侧可切换角色与配色（宣纸月华／桂影夜宴），选择记在本地。'),
        h('li', {}, '小屏下顶部导航换成底部标签栏，拇指可达。'))),
  );
  return modal({
    title: '使用说明',
    body,
    width: 720,
    actions: [{ label: '知道了', value: true, variant: 'btn--primary' }],
  });
}

/**
 * 「其他权限」折叠组：把对当前角色非必要的模块收进一处，
 * 而不是从界面上抹掉——用户升权后仍能找回入口。
 */
function othersGroup(cards, count) {
  const host = h('div', { class: 'entry-others__body', hidden: true },
    h('div', { class: 'grid grid--3' }, ...cards));
  const btn = h('button', {
    class: 'btn btn--sm entry-others__toggle',
    'aria-expanded': 'false',
    onClick: () => {
      const open = host.hidden;
      host.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
      btn.textContent = open ? `其他权限（${count}）▴` : `其他权限（${count}）▾`;
    },
  }, `其他权限（${count}）▾`);
  return h('div', { class: 'entry-others' },
    h('div', { class: 'entry-others__head' },
      h('span', { class: 't-sm t-faint' }, '对当前角色非必需的模块收在此处'),
      btn),
    host);
}

export function renderHome(store, { seed, auth, onPick, onNavigate }) {
  const persons = store.persons;
  const stats = computeStats(persons);
  const branches = branchStats(persons);
  const report = seed.buildReport;
  const role = auth?.role || 'guest';
  const root = h('div', { class: 'view' });

  /* ── 英雄区 ─────────────────────────────────────────── */
  /* 原籍介绍不再只给一句摘要：默认显示首段的长摘要，点击可展开
     《前言》中「从哪来、怎么落脚」的完整三段原文。 */
  const preface = seed.intro?.sections?.find((s) => s.id === 'PREFACE');
  const paras = preface?.paragraphs || [];
  const origin = ORIGIN_PARAS.map((i) => paras[i]).filter(Boolean);
  const lead = leadOf(origin[0] || paras[0] || '');

  const originBox = h('div', { class: 'hero__origin', id: 'hero-origin', hidden: true },
    h('div', { class: 'doc-body' }, ...origin.map((p) => h('p', {}, p))),
    h('div', { class: 'hero__origin-foot' },
      h('span', { class: 't-xs t-faint' },
        '节自《孙氏族谱前言》　九世孙 孙金德 撰　一九八三年七月一日'),
      h('button', { class: 'btn btn--sm', onClick: () => onNavigate('docs') }, '阅读全部文献 →')));

  const expandBtn = h('button', {
    class: 'btn btn--sm hero__expand',
    'aria-expanded': 'false',
    'aria-controls': 'hero-origin',
    onClick: () => {
      const open = originBox.hidden;
      originBox.hidden = !open;
      expandBtn.setAttribute('aria-expanded', String(open));
      expandBtn.textContent = open ? '收起原籍全文 ▴' : '展开原籍全文 ▾';
    },
  }, '展开原籍全文 ▾');

  root.appendChild(h('section', { class: 'hero' },
    h('div', { class: 'moon' }),
    h('div', { class: 'hero__clouds' }, ...CLOUDS()),
    h('div', { class: 'hero__inner' },
      h('div', { class: 'hero__eyebrow' }, 'Sun Clan · Genealogy'),
      h('h1', {}, '孙氏族谱'),
      h('p', { class: 'hero__lead' }, lead),
      h('div', { class: 'hero__meta' },
        badge('一世祖文友公 · 自山东迁辽东', 'gold'),
        badge(`现存 ${stats.maxGen} 世`, 'jade'),
        badge('六大支系', 'cinnabar'),
        badge(`${stats.total} 人`, 'muted')),
      h('div', { class: 'hero__actions' },
        h('button', {
          class: 'btn btn--primary hero__cta',
          onClick: () => onNavigate('docs'),
        }, '阅读谱牒文献 →'),
        h('button', {
          class: 'btn hero__cta',
          onClick: () => onNavigate('chart'),
        }, '浏览谱系图'),
        expandBtn),
      originBox)));

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
  /* 入口分两层：
   *   essential  —— 任何角色都用得上的浏览入口；
   *   restricted —— 与数据治理／复核相关，访客不必看到，
   *                 收进「其他权限」折叠组，而不是从界面上抹掉
   *                 （升权后仍能找回入口，也便于说明「还有别的功能」）。
   * 非访客角色直接平铺全部入口：对它们而言这些都是本职功能。
   *
   * 「谱牒文献」置于首位：族谱首先是文献，读者进门应先读到原文，
   * 再去看图形化的世系呈现。 */
  const essentialCards = [
    entryCard({
      icon: 'docs', label: '谱牒文献', desc: '前言、编后话、农垦考与三次修订说明原文',
      meta: '4,617 字', onClick: () => onNavigate('docs'),
    }),
    entryCard({
      icon: 'chart', label: '谱系图', desc: '纵向世系树，含配偶；可折叠、缩放、平移',
      meta: `${stats.maxGen} 世`, onClick: () => onNavigate('chart'),
    }),
    entryCard({
      icon: 'explore', label: '名录检索', desc: '按世代、支系筛选，世系树与列表双模式',
      meta: `${stats.total} 人`, onClick: () => onNavigate('explore'),
    }),
    entryCard({
      icon: 'genchar', label: '二十辈凡字', desc: '士仁公、道公公所定凡字与位置',
      meta: '20 字', onClick: () => onNavigate('docs'),
    }),
  ];
  const restrictedCards = [
    entryCard({
      icon: 'validate', label: '校验中心', desc: '独立交叉校验与待复核清单，可跳转原谱',
      meta: `${report.totals.issueTotal} 项`, onClick: () => onNavigate('validate'),
    }),
    entryCard({
      icon: 'admin', label: '权限与数据', desc: '角色切换、导入导出、审计日志',
      meta: '四角色', onClick: () => onNavigate('admin'),
    }),
  ];

  root.appendChild(sectionHead('从这里开始'));
  root.appendChild(h('div', { class: 'grid grid--3' }, ...essentialCards));
  if (role === 'guest') {
    root.appendChild(othersGroup(restrictedCards, restrictedCards.length));
  } else {
    root.appendChild(h('div', { class: 'grid grid--3 entry-extra' }, ...restrictedCards));
  }

  /* ── 使用说明（入口之后的引导） ─────────────────────── */
  root.appendChild(h('div', { class: 'entry-actions' },
    h('div', { class: 'entry-actions__text' },
      h('div', { class: 'entry-actions__title' }, '第一次来？'),
      h('div', { class: 't-sm t-faint' }, '各模块怎么用、图上怎么操作，一次讲清')),
    h('button', { class: 'btn btn--primary entry-actions__btn', onClick: openGuide },
      h('span', { class: 'btn__icon', html: `<svg viewBox="0 0 32 32" aria-hidden="true">${ICONS.help}</svg>` }),
      '使用说明')));

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

  /* ── 快速跳转（长页面末尾不必回顶栏） ────────────────── */
  root.appendChild(pageJump({
    current: 'home',
    onNavigate,
    note: '按 / 检索 · 按 g 直达谱系图',
  }));

  return root;
}
