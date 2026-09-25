/**
 * ui/viewChart.js — 谱系图形视图（SVG）
 * ---------------------------------------------------------------
 * 本站的主视图：以图形方式呈现谱系层级与血缘关系，而非文字列表。
 *
 * 两种图形模式
 *   · 世系树（tree）   —— 从某位祖先展开的全谱树：世代自上而下（或自左而右），
 *                          主干以实线相连、配偶以虚线并列，可逐节折叠、缩放平移。
 *   · 血缘关系图（focus）—— 以某人为中心的「沙漏图」：上为父辈、中为本人与配偶及
 *                          兄弟姐妹、下为子女，边上标注亲属称谓，一眼看清直系血缘。
 *
 * 交互
 *   点击节点     选中并展示档案（右侧栏）
 *   点击 +/−     折叠 / 展开该支
 *   滚轮         以指针为中心缩放
 *   拖拽         平移（桌面鼠标；触屏单指，放大后横纵皆可自由拖动）
 *   双指捏合     触屏缩放
 *   适应 / ±     视图缩放控制
 *   双击节点     以该人为根重新展开
 *
 * 触屏平移的关键约束（踩过的坑）
 *   `.chart-canvas` 默认 `touch-action: pan-y`，把纵向手势让给页面滚动。
 *   一旦浏览器认定是纵向滚动，后续 touchmove 会变成**不可取消**，
 *   此时在监听里 preventDefault() 已无效果——放大后图形超出画布却「拖不动」，
 *   根因就在这里。故改为按图形是否纵向溢出**动态**切换 touch-action：
 *     未溢出 → pan-y（保留页面滚动）
 *     已溢出 → none （手势全归图形，横纵自由平移）
 *   纵向是否溢出取决于当前缩放与布局尺寸，故每次变换后都要重新同步。
 *
 * 可读性设计
 *   · 世代背景带：每一代一条浅色横带并标注「N世」，纵向定位一目了然
 *   · 证据分色：明载（文献/主干行）实线、推导虚线，颜色区分，避免误读为定论
 *   · 高亮主干：选中人物时其祖先链高亮，其余淡化
 *   · 折叠计数：折叠节点显示隐藏后代数，避免"看起来这支没人"
 */

import { h, s, clear, $, toast } from '../core/dom.js';
import { GEN_LABELS } from '../core/schema.js';
import { displayName } from '../domain/person.js';
import { branchMeta } from '../domain/branch.js';
import { pageJump } from './components.js';
import { layoutTree, layoutFocus, fitTransform, stretchLevelGap, LEVEL_GAP, pathIds } from '../domain/layout.js';

const ORIENT_LABEL = { vertical: '纵向', horizontal: '横向' };

/**
 * 最小缩放（可读字号下限）。
 * 谱系图缩得太小就失去意义：全谱 157 人时纯按宽度适应会得到 scale≈0.109、字号 1.4px。
 * 因此默认视图只展开始祖以下 2 代（23 人，scale≈0.6），并在此设下 0.5 的下限——
 * 一旦用户展开到更宽的范围，图形宁可溢出画布（由用户左右拖拽查看），也不缩到读不出字。
 */
const MIN_SCALE = 0.5;

const DEPTH_OPTIONS = [
  { v: 2, label: '2 代' }, { v: 3, label: '3 代' }, { v: 4, label: '4 代' },
  { v: 5, label: '5 代' }, { v: 6, label: '6 代' }, { v: Infinity, label: '全部' },
];

export function createChartView(store, { auth, onPick, onEdit, onDelete, onAddChild, onAddSpouse, renderDetail, onNavigate }) {
  const state = {
    mode: 'tree',
    rootId: 'P0001',
    // 默认只展开始祖以下 2 代（共 3 世、23 人）：开箱即是一棵看得清的纵向树。
    // 展开到 4 代时整树宽 8846px，按宽度适应后字号仅 1.4px，会退化成一条横向细线。
    maxDepth: 2,
    orient: 'vertical',      // 世代自上而下（谱牒习惯），横向为可选项
    includeSpouses: true,    // 默认显示配偶节点
    collapsed: new Set(),
    selectedId: null,
    transform: null,         // {scale,tx,ty}
    // 持续适应：为 true 时每次重绘与容器尺寸变化都重新计算适应变换；
    // 用户一旦手动平移/缩放即置为 false，不再打扰其视角。
    fitMode: true,
  };

  const root = h('div', { class: 'view chart-view' });
  const toolbar = h('div', { class: 'chart-toolbar' });
  const canvas = h('div', { class: 'chart-canvas' });
  const aside = h('div', { class: 'chart-aside' });
  const legend = h('div', { class: 'chart-legend' });
  const statusBar = h('div', { class: 'chart-status' });

  let svgEl = null;
  let current = null;   // 最近一次布局结果
  let adoptionIdx = { out: new Map(), in: new Map() };
  let panCleanup = null;
  let resizeObserver = null;
  let refitPending = false;
  let zeroSizeRetries = 0;

  /* ── 尺寸变化后自动重新适应 ───────────────────────────
     容器尺寸在首次渲染时可能尚未确定（clientWidth/Height 为 0），
     也可能随窗口缩放、侧栏展开而改变。此处统一用一个 rAF 去抖的重绘入口。 */
  function scheduleRefit() {
    if (refitPending) return;
    refitPending = true;
    const raf = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (cb) => setTimeout(cb, 16);
    raf(() => {
      refitPending = false;
      if (state.fitMode) renderGraph();
    });
  }

  function ensureResizeObserver() {
    if (resizeObserver || typeof ResizeObserver === 'undefined') return;
    resizeObserver = new ResizeObserver(() => scheduleRefit());
    resizeObserver.observe(canvas);
  }


  /* ── 工具函数 ─────────────────────────────────────────── */

  /** 过继索引：out[出继子]=养父；in[养父]=[出继子…] */
  function indexAdoptions() {
    const out = new Map();
    const inn = new Map();
    for (const a of (store.adoptions || [])) {
      out.set(a.fromId, a.toId);
      if (!inn.has(a.toId)) inn.set(a.toId, []);
      inn.get(a.toId).push(a.fromId);
    }
    return { out, in: inn };
  }

  const byId = () => new Map(store.persons.map((p) => [p.id, p]));
  const personName = (id) => {
    const p = byId().get(id);
    return p ? displayName(p) : id;
  };

  function pickRoot(id) {
    state.rootId = id;
    state.collapsed = new Set();
    state.fitMode = true;
    refreshAll();
    toast(`已以「${personName(id)}」为根展开`, 'ok');
  }

  function select(id, { keepView = true } = {}) {
    state.selectedId = id;
    renderAside();
    renderGraph({ keepView });
  }

  /* ── 工具栏 ───────────────────────────────────────────── */

  function buildToolbar() {
    clear(toolbar);

    const rootSelect = h('select', { class: 'select', title: '选择展开的根人物' });
    const branchHeads = store.persons.filter((p) => p.gen === 3 && ['仁', '礼', '义', '智', '斌', '吉'].includes(p.name));
    const opts = [
      { id: 'P0001', label: '一世祖 文友公（全谱）' },
      ...branchHeads.map((p) => ({ id: p.id, label: `${GEN_LABELS[p.gen]}祖 ${p.name}（${p.name}支）` })),
    ];
    for (const o of opts) {
      rootSelect.appendChild(h('option', { value: o.id, selected: o.id === state.rootId }, o.label));
    }
    rootSelect.onchange = () => pickRoot(rootSelect.value);

    const depthSelect = h('select', { class: 'select', title: '展开层数' });
    for (const o of DEPTH_OPTIONS) {
      depthSelect.appendChild(h('option', { value: String(o.v), selected: o.v === state.maxDepth }, o.label));
    }
    depthSelect.onchange = () => {
      state.maxDepth = depthSelect.value === 'Infinity' ? Infinity : Number(depthSelect.value);
      state.fitMode = true;
      refreshAll();
    };

    const orientBtn = h('button', {
      class: 'btn btn--sm',
      title: '切换世代铺展方向',
      onClick: () => {
        state.orient = state.orient === 'vertical' ? 'horizontal' : 'vertical';
        state.fitMode = true;
        refreshAll();
      },
    }, `方向：${ORIENT_LABEL[state.orient]}`);

    const spouseBtn = h('button', {
      class: `btn btn--sm${state.includeSpouses ? ' is-on' : ''}`,
      title: '是否绘制配偶',
      onClick: () => {
        state.includeSpouses = !state.includeSpouses;
        state.fitMode = true;
        refreshAll();
      },
    }, state.includeSpouses ? '配偶：显示' : '配偶：隐藏');

    const modeBtn = h('button', {
      class: 'btn btn--sm',
      title: '切换「世系树」与「血缘关系图」',
      onClick: () => {
        state.mode = state.mode === 'tree' ? 'focus' : 'tree';
        state.fitMode = true;
        refreshAll();
      },
    }, state.mode === 'tree' ? '切到：血缘关系图' : '切到：世系树');

    toolbar.append(
      h('div', { class: 'chart-toolbar__group' },
        h('label', { class: 'chart-toolbar__label' }, '根'),
        rootSelect),
      h('div', { class: 'chart-toolbar__group' },
        h('label', { class: 'chart-toolbar__label' }, '展开'),
        depthSelect),
      h('div', { class: 'chart-toolbar__group' }, orientBtn, spouseBtn, modeBtn),
      h('div', { class: 'spacer' }),
      h('div', { class: 'chart-toolbar__group' },
        h('button', { class: 'btn btn--sm', title: '缩小', onClick: () => zoomBy(1 / 1.25) }, '−'),
        h('button', { class: 'btn btn--sm', title: '放大', onClick: () => zoomBy(1.25) }, '＋'),
        h('button', {
          class: 'btn btn--sm', title: '适应窗口',
          onClick: () => { state.fitMode = true; renderGraph(); },
        }, '适应')),
    );
  }

  function buildLegend() {
    clear(legend);
    const items = state.mode === 'tree'
      ? [
        ['主干人物', 'swatch-main'],
        ['配偶', 'swatch-spouse'],
        ['文献明载', 'swatch-doc'],
        ['主干行明载', 'swatch-spine'],
        ['推导待核', 'swatch-dashed'],
        ['过继（弧线）', 'swatch-adopt'],
      ]
      : [
        ['父辈', 'swatch-main'],
        ['养父', 'swatch-adoptive'],
        ['本人', 'swatch-self'],
        ['配偶', 'swatch-spouse'],
        ['子女 / 兄弟姐妹', 'swatch-muted'],
        ['过继', 'swatch-adopt'],
      ];
    legend.append(
      h('span', { class: 'chart-legend__title' }, '图例'),
      ...items.map(([label, cls]) => h('span', { class: 'chart-legend__item' },
        h('i', { class: `swatch ${cls}` }), label)),
    );
  }

  /* ── 图形渲染 ─────────────────────────────────────────── */

  function renderGraph({ keepView = false } = {}) {
    const host = canvas;
    const prev = keepView ? state.transform : null;
    clear(host);

    const opts = {
      rootId: state.rootId,
      maxDepth: state.maxDepth,
      orient: state.orient,
      includeSpouses: state.includeSpouses,
      collapsed: state.collapsed,
      focusId: state.selectedId,
      adoptions: store.adoptions || [],
    };

    const path = state.mode === 'tree' && state.selectedId
      ? pathIds(store.persons, state.selectedId) : null;

    let layout;
    if (state.mode === 'tree') {
      layout = layoutTree(store.persons, { ...opts, highlightPath: path });
      if (!layout.nodes.length) {
        host.appendChild(h('div', { class: 'chart-empty' }, '无可绘制的人物'));
        return;
      }
    } else {
      const focusId = state.selectedId || state.rootId;
      layout = layoutFocus(store.persons, focusId, { adoptions: store.adoptions || [] });
      if (!layout.nodes.length) {
        host.appendChild(h('div', { class: 'chart-empty' }, '请先选择一位人物'));
        return;
      }
    }

    // ── 视图尺寸 ──
    const rawW = host.clientWidth || 0;
    const rawH = host.clientHeight || 0;
    const hostW = Math.max(rawW || 900, 320);
    const hostH = Math.max(rawH || 520, 320);

    // 容器尚未完成布局（首次渲染常见）：先按兜底尺寸画一版，下一帧按真实尺寸重算
    if (!rawW || !rawH) {
      if (zeroSizeRetries < 5) { zeroSizeRetries += 1; scheduleRefit(); }
    } else {
      zeroSizeRetries = 0;
    }

    // ── 纵向舒展：世代数少时拉开层距，把画布纵向空间用起来 ──
    // 纵向布局的宽度与层距无关，故此步不会改变横向适应比例，也就不会让节点变小。
    if (state.mode === 'tree' && state.orient === 'vertical' && (layout.bands || []).length > 1) {
      const gap = stretchLevelGap(layout.bands.length, hostH);
      if (gap > LEVEL_GAP.vertical + 0.5) {
        layout = layoutTree(store.persons, { ...opts, highlightPath: path, levelGap: gap });
      }
    }
    current = layout;

    // ── 适应变换（含可读字号下限） ──
    const anchorId = state.mode === 'tree' ? state.rootId : (state.selectedId || state.rootId);
    const anchorNode = layout.nodes.find((n) => n.id === anchorId) || layout.nodes[0];
    const anchor = anchorNode
      ? { x: anchorNode.x + anchorNode.w / 2, y: anchorNode.y + anchorNode.h / 2 }
      : null;
    const fit = fitTransform(layout.bounds, hostW, hostH, {
      padding: 14,
      maxScale: state.mode === 'focus' ? 1.15 : 1.6,
      minScale: MIN_SCALE,
      focus: anchor,
    });
    state.transform = (state.fitMode || !prev) ? fit : prev;
    const tf = state.transform;

    // ── SVG 骨架 ──
    const svg = s('svg', {
      class: 'gc-svg', viewBox: `0 0 ${hostW} ${hostH}`,
      width: '100%', height: '100%',
      role: 'img', 'aria-label': '谱系图',
    });
    const defs = s('defs');
    // 父系线的方向箭头（世代方向 = 父 → 子）
    defs.appendChild(s('marker', {
      id: 'gcArrow', viewBox: '0 0 8 8', refX: '7.2', refY: '4',
      markerWidth: '5', markerHeight: '5', orient: 'auto',
    }, s('path', { class: 'gc-arrow', d: 'M0.5 0.8 L7.5 4 L0.5 7.2 z' })));
    svg.appendChild(defs);

    const gRoot = s('g', { class: 'gc-root', transform: `translate(${tf.tx} ${tf.ty}) scale(${tf.scale})` });

    // ── 世代背景带（坐标由布局引擎给出，保证与节点位置严格一致） ──
    for (const b of (layout.bands || [])) {
      gRoot.appendChild(s('rect', {
        class: 'gc-band', x: b.rect.x, y: b.rect.y,
        width: b.rect.width, height: b.rect.height, rx: 8,
      }));
      gRoot.appendChild(s('text', {
        class: 'gc-band-label', x: b.label.x, y: b.label.y, 'text-anchor': b.label.anchor,
      }, GEN_LABELS[b.gen] || `${b.gen}世`));
    }

    // ── 连线（先画，压在节点下） ──
    const gLinks = s('g', { class: 'gc-links' });
    for (const l of layout.links) {
      const isAdopt = l.kind === 'adoption' || l.adopt;
      const cls = l.kind === 'spouse' ? 'gc-link gc-link--spouse'
        : isAdopt ? 'gc-link gc-link--adopt'
          : `gc-link gc-link--${l.evidence || 'heuristic'}`;
      gLinks.appendChild(s('path', {
        class: cls, d: l.path, fill: 'none',
        'marker-end': l.kind === 'parent' && !isAdopt ? 'url(#gcArrow)' : null,
      }));
      if (l.label && (state.mode === 'focus' || isAdopt)) {
        const m = midOf(l.path);
        gLinks.appendChild(s('text', {
          class: `gc-link-label${isAdopt ? ' gc-link-label--adopt' : ''}`,
          x: m.x, y: m.y,
        }, l.label));
      }
    }
    gRoot.appendChild(gLinks);

    // ── 节点 ──
    const gNodes = s('g', { class: 'gc-nodes' });
    const selfId = state.mode === 'focus' ? (state.selectedId || state.rootId) : null;
    adoptionIdx = indexAdoptions();
    for (const n of layout.nodes) {
      gNodes.appendChild(nodeEl(n, selfId));
    }
    gRoot.appendChild(gNodes);

    svg.appendChild(gRoot);
    host.appendChild(svg);
    svgEl = svg;

    bindPanZoom(svg, gRoot);
    syncTouchAction();   // 每次重绘后重新判定手势归属（布局与缩放都可能已变）
    updateStatus(layout, {
      overflow: layout.bounds.width * tf.scale > hostW - 28
        || layout.bounds.height * tf.scale > hostH - 28,
    });
  }

  function nodeEl(n, selfId) {
    const p = n.person;
    const isSpouse = n.role === 'spouse';
    const adoptOut = adoptionIdx.out.has(p.id);
    const adoptIn = (adoptionIdx.in.get(p.id) || []).length;
    const cls = [
      'gc-node',
      isSpouse ? 'gc-node--spouse' : 'gc-node--main',
      // 局部血缘图中的角色类（father/adoptive/self/sibling/husband/child）
      !isSpouse && n.role && n.role !== 'main' ? `gc-node--${n.role}` : '',
      n.focus || p.id === selfId ? 'is-focus' : '',
      n.onPath ? 'is-path' : '',
      n.collapsed ? 'is-collapsed' : '',
      adoptOut ? 'is-adopted-out' : '',
      adoptIn ? 'is-adopted-in' : '',
      p.unnamed ? 'is-unnamed' : '',
      p.status && p.status !== 'normal' ? 'is-flagged' : '',
    ].filter(Boolean).join(' ');

    const g = s('g', {
      class: cls, 'data-id': p.id, tabindex: '0',
      transform: `translate(${n.x} ${n.y})`,
      role: 'button',
      'aria-label': `${displayName(p)}，${GEN_LABELS[p.gen]}，${branchMeta(p.branchId).short}支`
        + (adoptOut ? '，已出继' : '') + (adoptIn ? `，有 ${adoptIn} 名过继子` : ''),
      onClick: (e) => { e.stopPropagation(); select(p.id, { keepView: true }); },
      onDblclick: (e) => { e.stopPropagation(); if (!isSpouse) pickRoot(p.id); },
      onKeydown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(p.id); }
      },
    });

    g.appendChild(s('title', {}, `${displayName(p)}　${GEN_LABELS[p.gen]}　${branchMeta(p.branchId).name}`
      + (adoptOut ? `　（出继给 ${personName(adoptionIdx.out.get(p.id))}）` : '')
      + (adoptIn ? `　（入继 ${adoptIn} 子）` : '')));

    const stroke = evidenceStroke(p);
    g.appendChild(s('rect', {
      class: 'gc-node__box', x: 0, y: 0, width: n.w, height: n.h, rx: isSpouse ? 6 : 8,
      'stroke-dasharray': stroke,
    }));

    // 姓名（超长截断，完整名在 title 与侧栏中给出）
    const name = displayName(p);
    const fontSize = isSpouse ? 11.5 : 13;
    g.appendChild(s('text', {
      class: 'gc-node__name',
      x: n.w / 2, y: n.h / 2 + (isSpouse ? 4 : 5),
      'text-anchor': 'middle', 'font-size': fontSize,
    }, name.length > 5 ? name.slice(0, 5) : name));

    // 状态角标（少亡 / 孤 / 无后）
    if (p.status && p.status !== 'normal') {
      g.appendChild(s('text', {
        class: 'gc-node__flag', x: n.w - 4, y: 11, 'text-anchor': 'end', 'font-size': 9,
      }, p.status));
    }

    // 过继角标：出继（本人被过继出去）／入继（本人名下有入继之子）
    if (adoptOut) {
      g.appendChild(s('text', { class: 'gc-node__adopt', x: 4, y: n.h - 3.5, 'font-size': 8.5 }, '出继'));
    }
    if (adoptIn) {
      g.appendChild(s('text', {
        class: 'gc-node__adopt', x: n.w - 4, y: n.h - 3.5, 'text-anchor': 'end', 'font-size': 8.5,
      }, `入继${adoptIn > 1 ? adoptIn : ''}`));
    }

    // 折叠 / 展开控制
    if (n.hasChildren) {
      const cx = n.w / 2;
      const cy = n.h;
      const badge = s('g', {
        class: `gc-toggle${n.collapsed ? ' is-collapsed' : ''}`,
        role: 'button',
        'aria-label': n.collapsed ? `展开 ${n.childTotal} 名后代` : '折叠该支',
        onClick: (e) => {
          e.stopPropagation();
          if (state.collapsed.has(p.id)) state.collapsed.delete(p.id);
          else state.collapsed.add(p.id);
          renderGraph({ keepView: true });
        },
      },
      s('circle', { cx, cy, r: 9 }),
      s('text', { x: cx, y: cy + 3.5, 'text-anchor': 'middle', 'font-size': 11 },
        n.collapsed ? `+${n.childTotal}` : '−'));
      g.appendChild(badge);
    }

    return g;
  }

  /** 按证据强度决定节点描边样式：启发式推导者虚框，提示「待核」 */
  function evidenceStroke(p) {
    if (p.isSpouse) return null;
    if (p.parentEvidence === 'heuristic') return '3 3';
    return null;
  }

  /** 取路径中点用于放置标签；二次贝塞尔取 t=0.5 的真实曲线点 */
  function midOf(path) {
    const m = path.match(/^M([\d.eE+-]+)[ ,]([\d.eE+-]+)/);
    if (!m) return { x: 0, y: 0 };
    const p0 = { x: +m[1], y: +m[2] };
    const q = path.match(/Q([\d.eE+-]+)[ ,]([\d.eE+-]+)[ ,]([\d.eE+-]+)[ ,]([\d.eE+-]+)/);
    if (q) {
      const c = { x: +q[1], y: +q[2] };
      const p2 = { x: +q[3], y: +q[4] };
      return { x: 0.25 * p0.x + 0.5 * c.x + 0.25 * p2.x, y: 0.25 * p0.y + 0.5 * c.y + 0.25 * p2.y };
    }
    const pairs = [...path.matchAll(/([\d.eE+-]+)[ ,]([\d.eE+-]+)/g)];
    const last = pairs.length ? { x: +pairs[pairs.length - 1][1], y: +pairs[pairs.length - 1][2] } : p0;
    return { x: (p0.x + last.x) / 2, y: (p0.y + last.y) / 2 };
  }

  function updateStatus(layout, { overflow = false } = {}) {
    clear(statusBar);
    const s2 = layout.stats || {};
    const parts = state.mode === 'tree'
      ? [
        `主干 ${s2.mainCount ?? layout.nodes.length} 人`,
        state.includeSpouses ? `配偶 ${s2.spouseCount ?? 0} 人` : '配偶已隐藏',
        `父系线 ${s2.parentLinkCount ?? '—'} 条（明载 ${s2.explicitLinkCount ?? 0} · 待核 ${s2.inferredLinkCount ?? 0}）`,
        s2.adoptionLinkCount ? `过继线 ${s2.adoptionLinkCount} 条` : null,
        `展开 ${s2.depth ?? '—'} 代`,
        s2.truncated ? `另有 ${s2.truncated} 名后代待展开` : null,
      ]
      : [
        `父辈 ${layout.rows.up} 人`,
        `同辈 ${layout.rows.mid} 人`,
        `子辈 ${layout.rows.down} 人`,
        layout.info?.adoptive ? '本人已出继（另绘养父）' : null,
        layout.info?.adopted ? '名下有入继之子' : null,
        layout.overflow.siblings ? `另有 ${layout.overflow.siblings} 名兄弟姐妹未显示` : null,
        layout.overflow.children ? `另有 ${layout.overflow.children} 名子女未显示` : null,
      ];
    statusBar.append(...parts.filter(Boolean).map((t) => h('span', { class: 'chart-status__item' }, t)));
    // 已按可读字号下限显示而图形超出画布时，明确告知「拖拽可看全」
    if (overflow) {
      statusBar.appendChild(h('span', { class: 'chart-status__item chart-status__item--warn' },
        '已按可读字号显示，图形超出画布；拖拽（手机单指滑动）可平移查看'));
    }
    statusBar.appendChild(h('span', { class: 'chart-status__hint' },
      '滚轮缩放 · 拖拽平移 · 点击查看档案 · 双击以其为根'));
  }

  /* ── 缩放平移 ─────────────────────────────────────────── */

  /**
   * 图形是否超出画布。缩放后可能只在一个方向上溢出，
   * 两个方向分别判定：横向溢出向来由我们接管（touch-action 允许 pan-y 时
   * 横向手势仍可取消），纵向溢出才需要把 touch-action 改成 none。
   */
  function contentOverflow() {
    const b = current?.bounds;
    const t = state.transform;
    const cw = canvas.clientWidth || 0;
    const ch = canvas.clientHeight || 0;
    if (!b || !t || !cw || !ch) return { x: false, y: false };
    return {
      x: b.width * t.scale > cw + 1,
      y: b.height * t.scale > ch + 1,
    };
  }

  /**
   * 同步画布手势归属：纵向溢出时交出全部手势（none），否则保留页面纵向滚动（pan-y）。
   * 必须在**每次变换之后**调用——缩放会改变是否溢出，进而改变手势归属。
   */
  function syncTouchAction() {
    const ov = contentOverflow();
    const want = ov.y ? 'none' : 'pan-y';
    if (canvas.style.touchAction !== want) canvas.style.touchAction = want;
  }

  function applyTransform() {
    syncTouchAction();
    if (!svgEl) return;
    const g = svgEl.querySelector('.gc-root');
    const t = state.transform;
    if (g) g.setAttribute('transform', `translate(${t.tx} ${t.ty}) scale(${t.scale})`);
  }

  function zoomBy(factor, center) {
    const svg = svgEl;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const cx = center?.x ?? rect.width / 2;
    const cy = center?.y ?? rect.height / 2;
    const t = state.transform;
    const ns = Math.min(Math.max(t.scale * factor, 0.03), 4);
    const k = ns / t.scale;
    state.transform = { scale: ns, tx: cx - (cx - t.tx) * k, ty: cy - (cy - t.ty) * k };
    state.fitMode = false;
    applyTransform();
  }

  function bindPanZoom(svg, gRoot) {
    // 每次重绘都会生成新的 <svg>，旧的 window 级监听必须显式解除，否则泄漏
    if (panCleanup) { panCleanup(); panCleanup = null; }
    const offs = [];

    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;

    const onDown = (e) => {
      if (e.target.closest?.('.gc-node') || e.target.closest?.('.gc-toggle')) return;
      dragging = true;
      sx = e.clientX; sy = e.clientY;
      ox = state.transform.tx; oy = state.transform.ty;
      svg.classList.add('is-panning');
    };
    const onMove = (e) => {
      if (!dragging) return;
      state.transform = { ...state.transform, tx: ox + (e.clientX - sx), ty: oy + (e.clientY - sy) };
      state.fitMode = false;
      applyTransform();
    };
    const onUp = () => { dragging = false; svg.classList.remove('is-panning'); };

    svg.addEventListener('mousedown', onDown);
    svg.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    offs.push(() => {
      svg.removeEventListener('mousedown', onDown);
      svg.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    });

    // 以指针为中心滚轮缩放
    const onWheel = (e) => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, { x: e.clientX - rect.left, y: e.clientY - rect.top });
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    offs.push(() => svg.removeEventListener('wheel', onWheel));

    /* ── 触屏：单指平移、双指捏合缩放 ──
       纵向是否由我们接管，取决于图形是否纵向溢出（见 syncTouchAction）：
         · 未溢出：touch-action 为 pan-y，纵向手势归页面滚动，我们只接横向；
         · 已溢出：touch-action 为 none，纵向手势也归我们，横纵自由平移。
       一旦判定为「拖图形」（one.locked），本次手势内不再做轴判断，
       允许斜向自由平移——放大后想往哪儿看就往哪儿拖。 */
    let one = null, pinch = null;
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const midOfTouches = (t, rect) => ({
      x: (t[0].clientX + t[1].clientX) / 2 - rect.left,
      y: (t[0].clientY + t[1].clientY) / 2 - rect.top,
    });

    const onTouchStart = (e) => {
      if (e.touches.length === 2) {
        const rect = svg.getBoundingClientRect();
        pinch = { d0: dist(e.touches) || 1, s0: state.transform.scale, c: midOfTouches(e.touches, rect) };
        one = null;
      } else if (e.touches.length === 1) {
        one = {
          x: e.touches[0].clientX, y: e.touches[0].clientY,
          tx: state.transform.tx, ty: state.transform.ty, axis: null, locked: false,
        };
        pinch = null;
      }
    };
    const onTouchMove = (e) => {
      if (e.touches.length === 2 && pinch) {
        e.preventDefault();
        const ns = Math.min(Math.max(pinch.s0 * (dist(e.touches) / pinch.d0), 0.03), 4);
        const t = state.transform;
        const k = ns / t.scale;
        state.transform = {
          scale: ns,
          tx: pinch.c.x - (pinch.c.x - t.tx) * k,
          ty: pinch.c.y - (pinch.c.y - t.ty) * k,
        };
        state.fitMode = false;
        applyTransform();
        return;
      }
      if (e.touches.length === 1 && one) {
        const dx = e.touches[0].clientX - one.x;
        const dy = e.touches[0].clientY - one.y;
        if (!one.axis) {
          // 8px 死区：避免手指微颤被当成拖动，也避免误吞点击
          if (Math.abs(dx) + Math.abs(dy) < 8) return;
          one.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
        }
        // 纵向手势且图形未纵向溢出：交还页面滚动（此时 touch-action 为 pan-y，
        // 浏览器自行处理；我们若 preventDefault 反而会卡住页面）
        if (!one.locked && one.axis === 'y' && !contentOverflow().y) return;
        one.locked = true;
        e.preventDefault();
        state.transform = { ...state.transform, tx: one.tx + dx, ty: one.ty + dy };
        state.fitMode = false;
        applyTransform();
      }
    };
    const onTouchEnd = (e) => {
      if (e.touches.length === 0) { one = null; pinch = null; }
      else if (e.touches.length === 1) {
        pinch = null;
        one = {
          x: e.touches[0].clientX, y: e.touches[0].clientY,
          tx: state.transform.tx, ty: state.transform.ty, axis: null, locked: false,
        };
      }
    };

    svg.addEventListener('touchstart', onTouchStart, { passive: true });
    svg.addEventListener('touchmove', onTouchMove, { passive: false });
    svg.addEventListener('touchend', onTouchEnd);
    svg.addEventListener('touchcancel', onTouchEnd);
    offs.push(() => {
      svg.removeEventListener('touchstart', onTouchStart);
      svg.removeEventListener('touchmove', onTouchMove);
      svg.removeEventListener('touchend', onTouchEnd);
      svg.removeEventListener('touchcancel', onTouchEnd);
    });

    panCleanup = () => offs.forEach((fn) => fn());
    svg.__cleanup = panCleanup;
  }

  /* ── 侧栏 ─────────────────────────────────────────────── */

  function renderAside() {
    clear(aside);
    const p = state.selectedId ? byId().get(state.selectedId) : null;
    if (!p) {
      aside.appendChild(h('div', { class: 'chart-aside__hint' },
        h('div', { class: 'chart-aside__hint-title' }, '点击图中任一节点'),
        h('p', {}, '将在此显示该人物的档案、世系路径与直系亲属，并可进行编辑、添子、添配等操作。'),
        h('p', { class: 't-xs t-faint' },
          '双击节点可「以该人为根」重新展开图形；点击节点下方的 +/− 可折叠或展开该支。'),
        // 尚未选中人物时的去处：图上找不到人就去名录检索，看到虚框想核对就去校验中心
        h('div', { class: 'btn-row', style: { marginTop: '14px' } },
          h('button', { class: 'btn btn--sm', onClick: () => onNavigate('explore') }, '去名录检索人物'),
          h('button', { class: 'btn btn--sm', onClick: () => onNavigate('validate') }, '查看待复核清单'))));
      return;
    }
    aside.appendChild(h('div', { class: 'chart-aside__body' },
      renderDetail(p, { focusId: state.rootId }),
      // 图形与名录是同一份数据的两种看法：看完图想逐条比对，一键切过去
      h('div', { class: 'btn-row', style: { marginTop: '10px' } },
        h('button', {
          class: 'btn btn--sm',
          onClick: () => onPick(p.id, { view: 'explore' }),
        }, '在名录中查看'),
        h('button', { class: 'btn btn--sm', onClick: () => onNavigate('validate') }, '去校验中心'))));
  }

  /* ── 组装 ─────────────────────────────────────────────── */

  function refreshAll() {
    buildToolbar();
    buildLegend();
    renderGraph();
    renderAside();
  }

  function refresh() {
    // 数据变更后调用：清掉已失效的折叠与选中
    const ids = new Set(store.persons.map((p) => p.id));
    for (const id of [...state.collapsed]) if (!ids.has(id)) state.collapsed.delete(id);
    if (state.selectedId && !ids.has(state.selectedId)) state.selectedId = null;
    if (!ids.has(state.rootId)) state.rootId = 'P0001';
    state.fitMode = true;
    refreshAll();
  }

  const treeHost = h('div', { class: 'chart-main' }, toolbar, canvas, statusBar);
  root.append(h('div', { class: 'chart-split' },
    h('div', { class: 'chart-left' }, treeHost, legend),
    aside),
  pageJump({
    current: 'chart',
    onNavigate,
    extra: [{
      key: 'validate',
      hint: '图中虚线节点来自规则推导，需人工核对',
    }],
    note: '滚轮缩放 · 拖拽平移 · 双击节点改根',
  }));

  ensureResizeObserver();
  refreshAll();

  root.__refreshAll = refresh;
  root.__select = (id) => select(id, { keepView: false });
  root.__focus = (id) => { state.mode = 'focus'; select(id, { keepView: false }); refreshAll(); };
  return root;
}
