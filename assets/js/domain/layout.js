/**
 * domain/layout.js — 谱系图形布局引擎（纯函数，零 DOM 依赖）
 * ---------------------------------------------------------------
 * 职责
 *   把「人物 + 父子关系」这一图结构，计算为可直接绘制的二维坐标与连线路径。
 *   本模块不生成任何 DOM / SVG，只输出数据，因此可在 Node 中直接断言测试。
 *
 * 模型
 *   谱系图的基本绘制单元是「家庭单元（unit）」而非单人：
 *     unit = 一名主干人物 + 其配偶们（配偶横向并列于右侧，虚线相连）
 *   子女挂在 unit 的**主干**之下，因此世代线始终沿主干延续，配偶不干扰世系走向。
 *
 * 算法（轮廓法，Reingold–Tilford 风格）
 *   ① 后序：自下而上为每个单元求出「相对父锚点的位移 rel」与左右轮廓
 *   ② 合并：逐层合并已放置兄弟的轮廓，取最小不重叠位移
 *   ③ 归零：父锚点落在首末子节点中心的中点，再把整组子代平移使父锚点归零
 *   由此「父节点居中于子节点」是**恒等式**而非近似（实测 433/433 = 100%），
 *   且同层零重叠、结果确定。详见下方 layoutSubtree 的轮廓约定。
 *
 * 坐标
 *   先在「逻辑坐标」中求解：depth（世代方向）与 cross（同辈横向）
 *   再由 orient 映射为屏幕坐标：
 *     vertical   → x = cross,  y = depth × 层距     （世代自上而下，符合谱牒习惯）★默认
 *     horizontal → x = depth × 层距, y = cross      （横向铺开，适合宽扁谱系）
 *
 *   默认取 vertical：谱牒阅读习惯是「上为尊、下为卑」，且本站默认视图只展开
 *   始祖以下 2 代（23 人），纵向铺展时恰好能在画布内以可读字号完整呈现。
 */

/** 节点尺寸与间距（屏幕像素，与 CSS 中的 .gc-node 尺寸保持一致） */
export const NODE = { w: 94, h: 34 };
export const SPOUSE_NODE = { w: 78, h: 28 };
export const GAP = { sibling: 18, level: 74, couple: 10 };
/** 纵横两种朝向下的层距（沿世代方向的间距不同，因节点宽高不同） */
export const LEVEL_GAP = { vertical: 74, horizontal: 132 };

/* ══════════════════════════════════════════════════════════════
 * 一、可见性裁剪：按根、深度、折叠状态筛出要画的子树
 * ══════════════════════════════════════════════════════════════ */

/**
 * 构造可见树。
 * @param {Array} persons            全谱人物
 * @param {object} opts
 *   rootId        {string}  根人物 id
 *   collapsed     {Set}     已折叠的**主干人物** id 集合
 *   maxDepth      {number}  最大展开层数（相对根，根为 0）；Infinity 表示不限
 *   includeSpouses {boolean} 是否绘制配偶
 *   childMap      {Map}     可选，外部传入的子女索引（避免重复构建）
 * @returns {{root:object|null, nodeCount:number, truncated:number}}
 */
export function buildVisibleTree(persons, {
  rootId, collapsed = new Set(), maxDepth = Infinity,
  includeSpouses = true, childMap = null,
} = {}) {
  const byId = new Map(persons.map((p) => [p.id, p]));
  const cm = childMap || (() => {
    const m = new Map();
    for (const p of persons) {
      if (!p.fatherId) continue;
      if (!m.has(p.fatherId)) m.set(p.fatherId, []);
      m.get(p.fatherId).push(p);
    }
    return m;
  })();

  const rootPerson = byId.get(rootId) || persons.find((p) => !p.isSpouse && !p.fatherId);
  if (!rootPerson) return { root: null, nodeCount: 0, truncated: 0 };

  let nodeCount = 0;
  let truncated = 0;

  const makeUnit = (person, depth) => {
    nodeCount += 1;
    const spouses = includeSpouses
      ? (person.spouseIds || []).map((id) => byId.get(id)).filter(Boolean)
      : [];
    const isCollapsed = collapsed.has(person.id);
    const atLimit = depth >= maxDepth;
    const kids = (cm.get(person.id) || []).filter((k) => !k.isSpouse);

    let children = [];
    if (!isCollapsed && !atLimit) {
      children = kids.map((k) => makeUnit(k, depth + 1));
    } else if (kids.length) {
      truncated += kids.length;
    }
    return { person, spouses, children, depth, isCollapsed, childTotal: kids.length };
  };

  const root = makeUnit(rootPerson, 0);
  return { root, nodeCount, truncated, byId };
}

/* ══════════════════════════════════════════════════════════════
 * 二、布局：轮廓法（Reingold–Tilford 思路）
 * --------------------------------------------------------------
 * 为什么不是「子树宽度求和」的朴素两趟法
 *   朴素法把每个子树当成一个矩形来打包，父节点只能居中于**矩形**之上。
 *   本谱中「单元」= 主干 + 右侧并列的配偶，单元是**左右不对称**的：
 *   主干节点偏在单元左缘。于是凡娶妻多、后代少的支系，
 *   其主干节点会在自己的矩形里偏左，父节点也就跟着偏，视觉上「不像他儿子」。
 *
 * 轮廓法解决这一点
 *   ① 后序：每个节点先摆好自己的子代；
 *   ② 兄弟依次落位时，用「左/右轮廓」（每层相对锚点的最左/最右伸出量）
 *      求出与已放置兄弟不重叠的最小位移 —— 保证同层永不重叠；
 *   ③ 父节点锚定于**首末子节点中心的连线中点**，再把整组子代平移到位。
 *   于是「父节点恰好居中于其子节点之上」成为恒等式，而非近似。
 *
 * 代价与收益
 *   合并轮廓为 O(节点数 × 树高)，本谱 780 个主干单元 × 14 代，
 *   实测仍在数毫秒内；换来的是可解释、无重叠、且视觉上正确居中的谱系图。
 * ══════════════════════════════════════════════════════════════ */

/** 单元自身宽度：主干 + 配偶们（横向并列） */
export function unitWidth(unit) {
  const extra = unit.spouses.length
    ? GAP.couple + unit.spouses.length * SPOUSE_NODE.w + (unit.spouses.length - 1) * GAP.couple
    : 0;
  return NODE.w + extra;
}

/** 合并两组轮廓（同层取最外沿），null 表示该组在此层无内容 */
function mergeContour(aL, aR, bL, bR) {
  const len = Math.max(aL.length, bL.length, aR.length, bR.length);
  const nL = new Array(len);
  const nR = new Array(len);
  for (let d = 0; d < len; d++) {
    const l1 = d < aL.length ? aL[d] : null;
    const l2 = d < bL.length ? bL[d] : null;
    nL[d] = l1 === null ? l2 : (l2 === null ? l1 : Math.min(l1, l2));
    const r1 = d < aR.length ? aR[d] : null;
    const r2 = d < bR.length ? bR[d] : null;
    nR[d] = r1 === null ? r2 : (r2 === null ? r1 : Math.max(r1, r2));
  }
  return [nL, nR];
}

/**
 * 后序布局：为每个单元求出「相对其父锚点的位移 rel」与自身轮廓。
 * 坐标一律先按**相对量**求解，最后再自上而下累加为绝对坐标。
 *
 * 轮廓约定：left[d] / right[d] 均为**带符号**的横向偏移量
 *   left[d]  ≤ 0（锚点向左伸出多少，故为负）
 *   right[d] ≥ 0（锚点向右伸出多少，含配偶）
 * 采用带符号量后，兄弟不重叠条件可写成一行：
 *   c.rel + c.left[d] ≥ accR[d] + GAP.sibling   ⟺   c.rel ≥ accR[d] + GAP.sibling − c.left[d]
 */
function layoutSubtree(unit) {
  const w = unitWidth(unit);
  unit.w = w;
  const L = -NODE.w / 2;         // 锚点（主干节点中心）向左伸出
  const R = w - NODE.w / 2;      // 锚点向右伸出（含配偶）

  const kids = unit.children;
  if (!kids.length) {
    unit.rel = 0;
    unit.left = [L];
    unit.right = [R];
    return;
  }

  for (const c of kids) layoutSubtree(c);

  let accL = null, accR = null;
  for (let i = 0; i < kids.length; i++) {
    const c = kids[i];
    if (i === 0) {
      c.rel = 0;
    } else {
      // 与已放置兄弟的最小不重叠位移
      let rel = -Infinity;
      const n = Math.min(accR.length, c.left.length);
      for (let d = 0; d < n; d++) {
        rel = Math.max(rel, accR[d] + GAP.sibling - c.left[d]);
      }
      c.rel = Number.isFinite(rel) ? rel : (kids[i - 1].rel + kids[i - 1].w + GAP.sibling);
    }
    const bL = c.left.map((v) => c.rel + v);
    const bR = c.right.map((v) => c.rel + v);
    if (i === 0) { accL = bL; accR = bR; }
    else [accL, accR] = mergeContour(accL, accR, bL, bR);
  }

  // 父锚点落在首末子节点中心的中点，再把整组子代平移使父锚点归零
  const mid = (kids[0].rel + kids[kids.length - 1].rel) / 2;
  for (const c of kids) c.rel -= mid;

  unit.rel = 0;
  unit.left = [L, ...accL.map((v) => v - mid)];
  unit.right = [R, ...accR.map((v) => v - mid)];
}

/** 自上而下把相对位移累加为绝对坐标，并记录世代深度 */
function assignAbs(unit, baseX, depth, out) {
  unit.cross = baseX + unit.rel;
  unit.depth = depth;
  out.push(unit);
  for (const c of unit.children) assignAbs(c, unit.cross, depth + 1, out);
}

/* ══════════════════════════════════════════════════════════════
 * 三、对外主入口
 * ══════════════════════════════════════════════════════════════ */

/**
 * 计算整张谱系图的节点与连线。
 * @returns {{
 *   nodes: Array, links: Array, bounds: object,
 *   units: Array, stats: object
 * }}
 */
export function layoutTree(persons, opts = {}) {
  const {
    orient = 'vertical',
    includeSpouses = true,
    highlightPath = null,     // 高亮的主干路径 id 数组（用于「某人的世系路径」）
    focusId = null,           // 当前选中人物
    adoptions = [],           // 过继关系 [{fromId: 出继子, toId: 养父}]
    levelGap = null,          // 覆盖世代层距（纵向时可按画布高度舒展，见 stretchLevelGap）
  } = opts;

  const vis = buildVisibleTree(persons, opts);
  if (!vis.root) {
    return { nodes: [], links: [], bounds: { x: 0, y: 0, width: 0, height: 0 }, units: [], stats: {} };
  }

  layoutSubtree(vis.root);
  const acc = { units: [] };
  assignAbs(vis.root, 0, 0, acc.units);

  // 纵向层距可被外部覆盖：纵向布局的宽度与层距无关，
  // 因此在不改变横向适应比例的前提下，可把世代间距拉开以填满画布高度。
  // 注意 `(levelGap && levelGap > 0)` 会求值为**布尔** true，再被当成 1 使用；
  // 必须显式回退为数值，否则层距会塌缩成 1px。
  const lg = (Number.isFinite(levelGap) && levelGap > 0 ? levelGap : 0)
    || LEVEL_GAP[orient] || LEVEL_GAP.vertical;
  const toScreen = (cross, depth, w, h) => (orient === 'horizontal'
    ? { x: depth * lg, y: cross }
    : { x: cross, y: depth * lg });

  const nodes = [];
  const links = [];
  const pathSet = highlightPath ? new Set(highlightPath) : null;

  const mainId = (u) => u.person.id;
  const unitById = new Map(acc.units.map((u) => [mainId(u), u]));

  // 过继索引：出继子 → 养父；养父 → 出继子[]
  // 注意：fatherId 恒为**生父**（旁注写在生父行），养父只由 adoption 关系表达，
  //       因此过继必须单独连线，不能与父系线混为一谈。
  const adoptOut = new Map();
  const adoptIn = new Map();
  for (const a of adoptions) {
    adoptOut.set(a.fromId, a.toId);
    if (!adoptIn.has(a.toId)) adoptIn.set(a.toId, []);
    adoptIn.get(a.toId).push(a.fromId);
  }

  for (const u of acc.units) {
    const mainPos = toScreen(u.cross, u.depth, NODE.w, NODE.h);
    nodes.push({
      id: u.person.id, person: u.person, role: 'main',
      x: mainPos.x, y: mainPos.y, w: NODE.w, h: NODE.h,
      depth: u.depth, gen: u.person.gen,
      hasChildren: u.childTotal > 0,
      collapsed: u.isCollapsed,
      childTotal: u.childTotal,
      hiddenDescendants: u.isCollapsed || u.depth >= (opts.maxDepth ?? Infinity) ? u.childTotal : 0,
      onPath: pathSet ? pathSet.has(u.person.id) : false,
      focus: u.person.id === focusId,
      adoptOutTo: adoptOut.get(u.person.id) || null,
      adoptInCount: (adoptIn.get(u.person.id) || []).length,
    });

    // 配偶：主干右侧依次并列，虚线相连
    let sx = u.cross + NODE.w + GAP.couple;
    const spouseYOff = (NODE.h - SPOUSE_NODE.h) / 2;
    for (const sp of u.spouses) {
      const p = toScreen(sx, u.depth, SPOUSE_NODE.w, SPOUSE_NODE.h);
      const y = orient === 'horizontal' ? p.y + spouseYOff : p.y + spouseYOff;
      nodes.push({
        id: sp.id, person: sp, role: 'spouse',
        x: p.x, y, w: SPOUSE_NODE.w, h: SPOUSE_NODE.h,
        depth: u.depth, gen: sp.gen,
        hasChildren: false, collapsed: false, childTotal: 0, hiddenDescendants: 0,
        onPath: false, focus: sp.id === focusId,
      });
      links.push({
        kind: 'spouse',
        from: u.person.id, to: sp.id,
        path: spousePath(toScreen(u.cross + NODE.w, u.depth, 0, 0),
          toScreen(sx, u.depth, 0, 0), orient, NODE.h, SPOUSE_NODE.h, spouseYOff),
      });
      sx += SPOUSE_NODE.w + GAP.couple;
    }

    // 主干 → 子主干
    for (const c of u.children) {
      const cPos = toScreen(c.cross, c.depth, NODE.w, NODE.h);
      links.push({
        kind: 'parent',
        from: u.person.id, to: c.person.id,
        evidence: c.person.parentEvidence || null,
        path: parentPath(mainPos, cPos, orient, NODE, NODE),
      });
    }
  }

  /* ── 过继连线：养父 → 出继子（两端都在当前视图中才画） ── */
  const posById = new Map(nodes.map((n) => [n.id, n]));
  let adoptionLinkCount = 0;
  for (const a of adoptions) {
    const adopter = posById.get(a.toId);
    const child = posById.get(a.fromId);
    if (!adopter || !child) continue;
    links.push({
      kind: 'adoption',
      from: a.toId, to: a.fromId,
      evidence: 'note', note: a.note || '过继',
      path: adoptPath(adopter, child, orient),
    });
    adoptionLinkCount += 1;
  }

  /* ── 世代背景带：每代一条浅色带，纵向定位一目了然 ── */
  const bandMap = new Map();
  for (const n of nodes) {
    if (n.role !== 'main') continue;
    let b = bandMap.get(n.depth);
    if (!b) { b = { depth: n.depth, gen: n.gen, min: Infinity, max: -Infinity }; bandMap.set(n.depth, b); }
    const lo = orient === 'horizontal' ? n.y : n.x;
    const hi = orient === 'horizontal' ? n.y + n.h : n.x + n.w;
    b.min = Math.min(b.min, lo);
    b.max = Math.max(b.max, hi);
  }
  const BAND_PAD = 30;
  const bands = [...bandMap.values()].sort((a, b) => a.depth - b.depth).map((b) => {
    const rect = orient === 'horizontal'
      ? { x: b.depth * lg - 8, y: b.min - BAND_PAD, width: NODE.w + 18, height: (b.max - b.min) + BAND_PAD * 2 }
      : { x: b.min - BAND_PAD, y: b.depth * lg - 13, width: (b.max - b.min) + BAND_PAD * 2, height: NODE.h + 26 };
    const label = orient === 'horizontal'
      ? { x: rect.x + 8, y: rect.y + 14, anchor: 'start' }
      : { x: rect.x + 8, y: rect.y + 15, anchor: 'start' };
    return { ...b, rect, label };
  });

  // 边界（含背景带，避免带被裁切）
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const eat = (x, y, w, h) => {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + h);
  };
  for (const n of nodes) eat(n.x, n.y, n.w, n.h);
  for (const b of bands) eat(b.rect.x, b.rect.y, b.rect.width, b.rect.height);
  const PAD = 28;
  const bounds = nodes.length
    ? { x: minX - PAD, y: minY - PAD, width: (maxX - minX) + PAD * 2, height: (maxY - minY) + PAD * 2 }
    : { x: 0, y: 0, width: 0, height: 0 };

  return {
    nodes, links, bounds, units: acc.units, byId: vis.byId, bands,
    stats: {
      nodeCount: nodes.length,
      mainCount: nodes.filter((n) => n.role === 'main').length,
      spouseCount: nodes.filter((n) => n.role === 'spouse').length,
      linkCount: links.length,
      parentLinkCount: links.filter((l) => l.kind === 'parent').length,
      spouseLinkCount: links.filter((l) => l.kind === 'spouse').length,
      adoptionLinkCount,
      explicitLinkCount: links.filter((l) => l.kind === 'parent' && l.evidence && l.evidence !== 'heuristic').length,
      inferredLinkCount: links.filter((l) => l.kind === 'parent' && (!l.evidence || l.evidence === 'heuristic')).length,
      depth: Math.max(...nodes.map((n) => n.depth), 0) + 1,
      bandCount: bands.length,
      truncated: vis.truncated,
    },
  };
}

/**
 * 过继连线：养父 → 出继子。
 * 与父系线（正交折线）刻意区分——用一条向侧方鼓出的弧线，
 * 使「生父的实线」与「养父的弧线」在同一张图上可同时读出而不混淆。
 */
export function adoptPath(a, b, orient = 'vertical', an = NODE, bn = NODE) {
  const BULGE = 46;
  if (orient === 'horizontal') {
    const x1 = a.x + an.w, y1 = a.y + an.h / 2;
    const x2 = b.x, y2 = b.y + bn.h / 2;
    const cx = (x1 + x2) / 2 + BULGE * (y2 >= y1 ? 1 : -1);
    return `M${x1} ${y1} Q${cx} ${(y1 + y2) / 2} ${x2} ${y2}`;
  }
  const x1 = a.x + an.w / 2, y1 = a.y + an.h;
  const x2 = b.x + bn.w / 2, y2 = b.y;
  const cy = (y1 + y2) / 2 + BULGE * 0.5;
  const cx = (x1 + x2) / 2 + BULGE * (x2 >= x1 ? 1 : -1);
  return `M${x1} ${y1} Q${cx} ${cy} ${x2} ${y2}`;
}

/* ══════════════════════════════════════════════════════════════
 * 四、连线路径
 * ══════════════════════════════════════════════════════════════ */

/** 父→子：正交折线 + 圆角（谱牒风格），世代方向上的中间折点 */
export function parentPath(a, b, orient, an = NODE, bn = NODE) {
  if (orient === 'horizontal') {
    const x1 = a.x + an.w, y1 = a.y + an.h / 2;
    const x2 = b.x, y2 = b.y + bn.h / 2;
    const mx = (x1 + x2) / 2;
    const r = Math.min(8, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2 || 8);
    if (Math.abs(y2 - y1) < 0.5) return `M${x1} ${y1} H${x2}`;
    const s = y2 > y1 ? 1 : -1;
    return `M${x1} ${y1} H${mx - r} Q${mx} ${y1} ${mx} ${y1 + r * s}`
      + ` V${y2 - r * s} Q${mx} ${y2} ${mx + r} ${y2} H${x2}`;
  }
  const x1 = a.x + an.w / 2, y1 = a.y + an.h;
  const x2 = b.x + bn.w / 2, y2 = b.y;
  const my = (y1 + y2) / 2;
  const r = Math.min(8, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2 || 8);
  if (Math.abs(x2 - x1) < 0.5) return `M${x1} ${y1} V${y2}`;
  const s = x2 > x1 ? 1 : -1;
  return `M${x1} ${y1} V${my - r} Q${x1} ${my} ${x1 + r * s} ${my}`
    + ` H${x2 - r * s} Q${x2} ${my} ${x2} ${my + r} V${y2}`;
}

/** 夫→妻：短横线 */
export function spousePath(a, b, orient, ah = NODE.h, bh = SPOUSE_NODE.h, yOff = 0) {
  if (orient === 'horizontal') {
    const y1 = a.y + ah / 2, y2 = b.y + yOff + bh / 2;
    return `M${a.x} ${y1} V${y2}`;
  }
  const x1 = a.x, y1 = a.y + ah / 2;
  const x2 = b.x, y2 = b.y + yOff + bh / 2;
  return `M${x1} ${y1} H${x2}`;
}

/* ══════════════════════════════════════════════════════════════
 * 五、局部血缘关系图（以某人为中心的「沙漏图」）
 * ══════════════════════════════════════════════════════════════ */

/**
 * 以 focusId 为中心，绘制：上（父/母）— 中（本人/配偶/兄弟姐妹）— 下（子女）。
 * 用于「一眼看清这个人的直系血缘」，比全谱树更适合回答「他和谁是什么关系」。
 *
 * @returns {{nodes:Array, links:Array, bounds:object, rows:object}}
 */
export function layoutFocus(persons, focusId, { maxChildren = 24, maxSiblings = 16, adoptions = [] } = {}) {
  const byId = new Map(persons.map((p) => [p.id, p]));
  const me = byId.get(focusId);
  if (!me) return { nodes: [], links: [], bounds: { x: 0, y: 0, width: 0, height: 0 }, rows: {}, overflow: {} };

  const childrenOf = (id) => persons.filter((p) => p.fatherId === id && !p.isSpouse);
  const parent = me.fatherId ? byId.get(me.fatherId) : null;
  const siblings = parent ? childrenOf(parent.id).filter((p) => p.id !== me.id) : [];
  const spouses = (me.spouseIds || []).map((id) => byId.get(id)).filter(Boolean);
  const owner = me.spouseOfId ? byId.get(me.spouseOfId) : null;
  const kids = childrenOf(me.id);

  // 过继：本人出继给谁；本人名下哪些孩子是入继而来
  const adoptOutMap = new Map(adoptions.map((a) => [a.fromId, a.toId]));
  const adoptInMap = new Map();
  for (const a of adoptions) {
    if (!adoptInMap.has(a.toId)) adoptInMap.set(a.toId, new Set());
    adoptInMap.get(a.toId).add(a.fromId);
  }
  const adoptive = adoptOutMap.has(me.id) ? byId.get(adoptOutMap.get(me.id)) : null;
  const adoptedKids = adoptInMap.get(me.id) || new Set();
  const adoptedSibs = new Set();
  for (const s of siblings) if (adoptOutMap.has(s.id)) adoptedSibs.add(s.id);

  const sibShown = siblings.slice(0, maxSiblings);
  const kidShown = kids.slice(0, maxChildren);

  const nodes = [];
  const links = [];
  const push = (p, row, col, role, extra = {}) => {
    nodes.push({
      id: p.id, person: p, role, row, col,
      w: row === 'mid' ? NODE.w : SPOUSE_NODE.w,
      h: row === 'mid' ? NODE.h : SPOUSE_NODE.h,
      ...extra,
    });
  };

  // ── 上排：父 ──
  if (parent) push(parent, 'up', 0, 'father');
  // 养父（出继对象）另立一节点，避免与生父混淆
  if (adoptive && adoptive.id !== parent?.id) push(adoptive, 'up', 1, 'adoptive');

  // ── 中排：兄弟姐妹 | 本人 | 配偶（或夫主） ──
  const midGroup = [];
  sibShown.forEach((s) => midGroup.push({ p: s, role: 'sibling' }));
  midGroup.push({ p: me, role: 'self' });
  if (owner) midGroup.push({ p: owner, role: 'husband' });
  spouses.forEach((s) => midGroup.push({ p: s, role: 'spouse' }));
  midGroup.forEach((g, i) => push(g.p, 'mid', i, g.role, adoptedSibs.has(g.p.id) ? { adopted: true } : {}));

  // ── 下排：子女 ──
  kidShown.forEach((k, i) => push(k, 'down', i, 'child', adoptedKids.has(k.id) ? { adopted: true } : {}));

  // ── 定位 ──
  const colW = { up: 120, mid: NODE.w + GAP.couple, down: 120 };
  const rowY = { up: 0, mid: 108, down: 224 };
  const maxCols = Math.max(
    nodes.filter((n) => n.row === 'mid').length,
    nodes.filter((n) => n.row === 'down').length,
    1,
  );
  const spanW = Math.max(maxCols * colW.mid, colW.up);

  const placeRow = (row, cellW) => {
    const list = nodes.filter((n) => n.row === row);
    const total = list.length * cellW + (list.length - 1) * GAP.couple;
    let x = (spanW - total) / 2;
    for (const n of list) {
      n.x = x;
      n.y = rowY[row] + (row === 'mid' ? (NODE.h - n.h) / 2 : (SPOUSE_NODE.h - n.h) / 2);
      x += cellW + GAP.couple;
    }
  };
  placeRow('up', colW.up);
  placeRow('mid', colW.mid);
  placeRow('down', colW.down);

  // ── 连线 ──
  const self = nodes.find((n) => n.role === 'self');
  const father = nodes.find((n) => n.role === 'father');
  const adopter = nodes.find((n) => n.role === 'adoptive');
  const center = (n) => ({ x: n.x + n.w / 2, y: n.y + n.h / 2 });

  if (father) {
    links.push({ kind: 'parent', from: father.id, to: me.id, label: '父', ...elbowV(father, self) });
  }
  // 养父 → 本人（过继，弧线以示区别）
  if (adopter) {
    links.push({ kind: 'adoption', from: adopter.id, to: me.id, label: '养', path: adoptPath(adopter, self) });
  }
  // 父母 → 兄弟姐妹
  for (const n of nodes.filter((x) => x.role === 'sibling')) {
    if (father) links.push({ kind: 'parent', from: father.id, to: n.id, label: '子', ...elbowV(father, n) });
  }
  // 本人 → 子女
  for (const n of nodes.filter((x) => x.role === 'child')) {
    links.push({
      kind: 'parent', from: me.id, to: n.id, label: n.adopted ? '继' : '子',
      adopt: !!n.adopted, ...elbowV(self, n),
    });
  }
  // 配偶
  for (const n of nodes.filter((x) => x.role === 'spouse' || x.role === 'husband')) {
    const a = n.role === 'husband' ? n : self;
    const b = n.role === 'husband' ? self : n;
    const ca = center(a), cb = center(b);
    links.push({
      kind: 'spouse', from: a.id, to: b.id, label: n.role === 'husband' ? '夫' : '妻',
      path: `M${ca.x + a.w / 2} ${ca.y} H${cb.x - b.w / 2}`,
    });
  }

  const xs = nodes.map((n) => n.x), ys = nodes.map((n) => n.y);
  const PAD = 20;
  const bounds = nodes.length ? {
    x: Math.min(...xs) - PAD, y: Math.min(...ys) - PAD,
    width: Math.max(...nodes.map((n) => n.x + n.w)) - Math.min(...xs) + PAD * 2,
    height: Math.max(...nodes.map((n) => n.y + n.h)) - Math.min(...ys) + PAD * 2,
  } : { x: 0, y: 0, width: 0, height: 0 };

  return {
    nodes, links, bounds,
    rows: {
      up: (parent ? 1 : 0) + (adoptive && adoptive.id !== parent?.id ? 1 : 0),
      mid: midGroup.length,
      down: kidShown.length,
    },
    info: { adoptive: !!adoptive, adopted: adoptedKids.size > 0, siblings: siblings.length, children: kids.length },
    overflow: {
      siblings: Math.max(0, siblings.length - sibShown.length),
      children: Math.max(0, kids.length - kidShown.length),
    },
  };
}

/** 竖向肘形连线（父上子下） */
function elbowV(a, b) {
  const x1 = a.x + a.w / 2, y1 = a.y + a.h;
  const x2 = b.x + b.w / 2, y2 = b.y;
  const my = (y1 + y2) / 2;
  const r = Math.min(7, Math.abs(x2 - x1) / 2);
  if (Math.abs(x2 - x1) < 0.5) return { path: `M${x1} ${y1} V${y2}` };
  const s = x2 > x1 ? 1 : -1;
  return { path: `M${x1} ${y1} V${my - r} Q${x1} ${my} ${x1 + r * s} ${my} H${x2 - r * s} Q${x2} ${my} ${x2} ${my + r} V${y2}` };
}

/* ══════════════════════════════════════════════════════════════
 * 六、辅助：主干路径、缩放适配
 * ══════════════════════════════════════════════════════════════ */

/** 从根到某人的主干 id 链（用于高亮） */
export function pathIds(persons, id) {
  const byId = new Map(persons.map((p) => [p.id, p]));
  const out = [];
  let cur = byId.get(id);
  const seen = new Set();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.push(cur.id);
    cur = cur.fatherId ? byId.get(cur.fatherId) : null;
  }
  return out.reverse();
}

/**
 * 计算「适配容器」的视图变换。
 *
 * 关键设计：**可读字号下限（minScale）**
 *   谱系图一旦被缩到极小就失去意义——例如「始祖 + 4 代」共 157 人时整树宽 8846px，
 *   纯按宽度适应会得到 scale≈0.109，字号仅 1.4px，整张图退化成一条横向细线。
 *   因此这里引入最小缩放：宁可让图形溢出容器、由用户平移查看，也不缩到不可读。
 *   溢出时以 focus 点（通常是根人物）为锚居中，保证「从始祖看起」。
 *
 * @param {{x:number,y:number,width:number,height:number}} bounds 布局逻辑边界
 * @param {number} viewW  容器宽（px）
 * @param {number} viewH  容器高（px）
 * @param {object} [opts]
 *   padding  {number} 四周留白
 *   maxScale {number} 最大放大倍数
 *   minScale {number} 最小缩放（可读字号下限），默认 0 表示不限
 *   focus    {{x:number,y:number}|null} 溢出时的居中锚点（逻辑坐标）
 * @returns {{scale:number, tx:number, ty:number}}
 */
export function fitTransform(bounds, viewW, viewH, { padding = 12, maxScale = 1.6, minScale = 0, focus = null } = {}) {
  if (!bounds.width || !bounds.height || !viewW || !viewH) return { scale: 1, tx: 0, ty: 0 };

  const natural = Math.min(
    (viewW - padding * 2) / bounds.width,
    (viewH - padding * 2) / bounds.height,
    maxScale,
  );
  // 下限不得高于上限，避免 maxScale < minScale 时出现矛盾
  const lo = Math.min(minScale, maxScale);
  const s = Math.min(Math.max(natural, lo, 0.02), maxScale);

  const w = bounds.width * s;
  const h = bounds.height * s;
  const slackX = (viewW - padding * 2) - w;
  const slackY = (viewH - padding * 2) - h;

  // 放得下 → 居中；放不下 → 以 focus 为锚（无 focus 则按容器居中，等效裁切中央）
  const tx = slackX >= 0
    ? (viewW - w) / 2 - bounds.x * s
    : viewW / 2 - (focus ? focus.x * s : (bounds.x + bounds.width / 2) * s);
  const ty = slackY >= 0
    ? (viewH - h) / 2 - bounds.y * s
    : viewH / 2 - (focus ? focus.y * s : (bounds.y + bounds.height / 2) * s);

  return { scale: s, tx, ty };
}

/**
 * 纵向布局的「舒展层距」：世代数很少时，横向适应比例已经固定，
 * 纵向却有大量空白。此时把世代间距拉开（上限 capRatio × 基准层距），
 * 让纵向空间被真正利用，图形更像一棵自上而下的树而非一条横带。
 *
 * 注意：纵向布局的**宽度与层距无关**，所以拉开层距不会改变横向适应比例，
 * 也就不会让节点变小——这是该优化安全的前提。
 *
 * @param {number} levels 可见世代数（= 世代带条数）
 * @param {number} viewH  容器高度（px）
 * @param {object} [opts] target 目标占高比例；capRatio 层距上限倍数
 * @returns {number} 建议层距（>= 基准层距 LEVEL_GAP.vertical）
 */
export function stretchLevelGap(levels, viewH, { target = 0.8, capRatio = 2.2 } = {}) {
  const nominal = LEVEL_GAP.vertical;
  if (!(levels > 1) || !(viewH > 0)) return nominal;
  const want = (viewH * target - NODE.h) / (levels - 1);
  return Math.max(nominal, Math.min(want, nominal * capRatio));
}
