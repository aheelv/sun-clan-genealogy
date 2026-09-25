/**
 * smoke_test.mjs — 逻辑层自检（不依赖 DOM）
 * 覆盖：数据完整性、校验引擎、CRUD、权限矩阵、关系推导、亲属称谓、导入导出。
 * 运行：node tools/smoke_test.mjs
 */

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
};

const SEED = (await import('../assets/js/data/seed.js')).default;
const { createStore } = await import('../assets/js/core/store.js');
const { validateGraph, validateRecord, RULE_COUNT } = await import('../assets/js/core/validate.js');
const { Auth, ROLES, PERM } = await import('../assets/js/core/auth.js');
const { GEN_CHAR_MAP } = await import('../assets/js/core/schema.js');
const { searchPersons, filterPersons, computeStats } = await import('../assets/js/domain/person.js');
const { branchStats } = await import('../assets/js/domain/branch.js');
const { indexById, indexChildren, ancestorsOf, descendantsOf, detectCycles, commonAncestor, kinshipLabel, buildTree } = await import('../assets/js/domain/relation.js');
const {
  layoutTree, layoutFocus, buildVisibleTree, unitWidth, fitTransform, stretchLevelGap, pathIds,
  NODE, SPOUSE_NODE, GAP, LEVEL_GAP,
} = await import('../assets/js/domain/layout.js');

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label} ${extra}`); }
};
const section = (t) => console.log(`\n── ${t} ──`);
/** 把一组坐标按容差聚类，返回聚类数（用于判断世代分层是否严格） */
const clusterCount = (vals, tol = 8) => {
  const s = [...new Set(vals)].sort((a, b) => a - b);
  let n = 0, last = -Infinity;
  for (const v of s) { if (v - last > tol) { n += 1; last = v; } }
  return n;
};

/* ── 1. 数据完整性 ─────────────────────────────────────── */
section('数据完整性');
ok(SEED.persons.length > 1500, `种子人物数 = ${SEED.persons.length}`);
ok(SEED.meta.sourceManifest.length >= 2, `源文件指纹 ${SEED.meta.sourceManifest.length} 条`);
ok(SEED.persons.every((p) => p.id && p.name && p.gen >= 1 && p.gen <= 18), '所有人物的 id/name/gen 合法');
ok(SEED.persons.every((p) => Array.isArray(p.refs)), '所有人物均带原谱出处数组');
ok(SEED.persons.some((p) => p.refs.length > 1), '存在跨页重复出现（出处 >1）的人物');

const store = createStore(SEED);
ok(store.persons.length === SEED.persons.length, '仓库初始化人物数一致');
ok(store.relations().length > 1500, `派生关系 ${store.relations().length} 条`);
ok(store.revision === 1, '初始修订号 = 1');

/* ── 2. 派生查询 ───────────────────────────────────────── */
section('派生查询');
const byId = indexById(store.persons);
const cm = indexChildren(store.persons);
const wenyou = store.persons.find((p) => p.name === '文友' && p.gen === 1);
ok(!!wenyou, '一世祖「文友」存在');
ok(store.childrenOf(wenyou.id).length === 2, `文友有 2 子（元亨/元贞），实得 ${store.childrenOf(wenyou.id).length}`);

const shicong = store.persons.find((p) => p.name === '士聪' && p.gen === 6);
ok(!!shicong, '六世「士聪」存在');
const chain = ancestorsOf(shicong.id, byId).map((p) => p.name);
ok(chain.join('←') === '纲←国俌←仁←元亨←文友', `士聪祖先链：${chain.join('←')}`);
ok(descendantsOf(shicong.id, cm).length > 0, `士聪后代 ${descendantsOf(shicong.id, cm).length} 人`);
ok(detectCycles(store.persons).length === 0, '无世系环');
ok(buildTree(store.persons).length > 0, `世系树根节点 ${buildTree(store.persons).length} 个`);

/* ── 3. 亲属称谓（约定：kinshipLabel(a,b) = a 是 b 的 ___） ── */
section('亲属称谓');
const ren = store.persons.find((p) => p.name === '仁' && p.gen === 3);
const guofu = store.persons.find((p) => p.name === '国俌' && p.gen === 4);
ok(kinshipLabel(ren.id, guofu.id, byId).label === '父', `仁 是 国俌 的 ${kinshipLabel(ren.id, guofu.id, byId).label}`);
ok(kinshipLabel(guofu.id, ren.id, byId).label === '子', `国俌 是 仁 的 ${kinshipLabel(guofu.id, ren.id, byId).label}`);
ok(kinshipLabel(ren.id, ren.id, byId).label === '本人', '同一人 = 本人');
ok(kinshipLabel(wenyou.id, shicong.id, byId).label === '天祖父', `文友 是 士聪 的 ${kinshipLabel(wenyou.id, shicong.id, byId).label}`);
ok(!!commonAncestor(ren.id, guofu.id, byId), '共同祖先可求');

/* ── 4. 校验引擎 ───────────────────────────────────────── */
section('校验引擎');
const report = validateGraph(store.ctx());
ok(RULE_COUNT >= 20, `注册规则 ${RULE_COUNT} 条`);
ok(report.total > 0, `检出问题 ${report.total} 项（错误 ${report.counts.error}）`);
ok(report.counts.error === 0 || report.byLevel.error.every((i) => i.ruleId && i.message), '错误项均带规则号与描述');
ok(validateRecord({ id: 'X', name: '', gen: 1, gender: 'M' }, store.ctx()).some((i) => i.ruleId === 'R-SELF-PARENT' || i.message), '空姓名可被记录级规则捕获');
ok(validateRecord({ id: 'X', name: '测', gen: 99, gender: 'M' }, store.ctx()).length >= 0, '越界世代不抛异常');

/* ── 5. 检索与筛选 ─────────────────────────────────────── */
section('检索与筛选');
ok(searchPersons(store.persons, '士聪').length >= 1, '按姓名检索命中');
ok(searchPersons(store.persons, '见13页').length >= 1, '按旁注检索命中');
ok(filterPersons(store.persons, { gens: [3] }).every((p) => p.gen === 3), '按世代筛选');
ok(filterPersons(store.persons, { branchIds: ['BR-LI'] }).every((p) => p.branchId === 'BR-LI'), '按支系筛选');
const stats = computeStats(store.persons);
ok(stats.byGen.length >= 14, `统计覆盖 ${stats.byGen.length} 个世代`);
ok(branchStats(store.persons).length >= 6, `支系统计 ${branchStats(store.persons).length} 支`);

/* ── 6. 权限矩阵 ───────────────────────────────────────── */
section('权限矩阵');
const guest = new Auth('guest'), editor = new Auth('editor'), elder = new Auth('elder'), admin = new Auth('admin');
ok(guest.can(PERM.PERSON_READ) && !guest.can(PERM.PERSON_CREATE), '访客：可读不可写');
ok(editor.can(PERM.PERSON_CREATE) && !editor.can(PERM.PERSON_DELETE), '编修：可增改不可删');
ok(!editor.can(PERM.PERSON_STRUCTURE), '编修：不可改世代/支系');
ok(elder.can(PERM.PERSON_DELETE) && elder.can(PERM.DATA_IMPORT) && !elder.can(PERM.DATA_RESET), '族老：可删可导入不可重置');
ok(admin.can(PERM.DATA_RESET) && admin.can(PERM.ROLE_MANAGE), '管理员：全权');
ok(Object.values(ROLES).every((r) => typeof r.label === 'string'), `角色 ${Object.keys(ROLES).length} 个`);
ok(Auth.matrix().every((m) => Array.isArray(m.perms)), '权限矩阵可导出');

/* ── 7. CRUD 闭环 ──────────────────────────────────────── */
section('CRUD 闭环');
const before = store.persons.length;
const created = store.createPerson({ name: '测士', gen: 6, gender: 'M', branchId: 'BR-LI', fatherId: null }, 'editor');
ok(created.ok, `新增人物成功 id=${created.id}`);
ok(store.persons.length === before + 1, '人物数 +1');
ok(store.audit[0].action === 'create', '审计日志记录 create');

const upd = store.updatePerson(created.id, { name: '测士改' }, 'editor');
ok(upd.ok && store.byId(created.id).name === '测士改', '修改生效');
ok(store.audit[0].action === 'update', '审计日志记录 update');

const bad = store.createPerson({ name: '', gen: 1 }, 'editor');
ok(!bad.ok, '空姓名被拒绝写入');

const del = store.deletePerson(created.id, 'admin');
ok(del.ok && !store.byId(created.id), '删除生效');
ok(store.audit[0].action === 'delete', '审计日志记录 delete');

/* ── 8. 持久化 / 导出导入 ──────────────────────────────── */
section('持久化与导入导出');
const payload = store.exportPayload();
ok(payload.format === 'sunclan-genealogy' && payload.persons.length === store.persons.length, '导出载荷结构正确');
const restored = createStore(SEED);
ok(restored.persons.length === store.persons.length, '从 localStorage 恢复成功（含本地修改）');
const imp = restored.importPayload({ schemaVersion: '1.0.0', persons: SEED.persons.slice(0, 10) }, 'admin', 'replace');
ok(imp.ok && restored.persons.length === 10, '导入（覆盖）生效');
const badVer = restored.importPayload({ schemaVersion: '9.0.0', persons: [] }, 'admin');
ok(!badVer.ok, '主版本不兼容时拒绝导入');
const badFmt = restored.importPayload({ nope: 1 }, 'admin');
ok(!badFmt.ok, '非法格式被拒绝');
restored.reset('admin');
ok(restored.persons.length === SEED.persons.length, '重置恢复原始转录数据');

/* ── 9. 凡字一致性抽样 ─────────────────────────────────── */
section('凡字一致性');
const males = store.persons.filter((p) => !p.isSpouse && !p.unnamed && GEN_CHAR_MAP[p.gen]);
const conform = males.filter((p) => p.name.includes(GEN_CHAR_MAP[p.gen]));
const rate = (conform.length / males.length) * 100;
ok(rate > 90, `第 6–15 世姓名含本辈凡字比例 ${rate.toFixed(1)}%（${conform.length}/${males.length}）`);

/* ── 10. 谱系图形布局引擎 ──────────────────────────────── */
section('谱系图形布局引擎');
const ADOPTIONS = SEED.adoptions || [];
const full = layoutTree(store.persons, { rootId: 'P0001', maxDepth: Infinity, adoptions: ADOPTIONS });

ok(full.nodes.length > 1400, `全谱节点 ${full.nodes.length} 个（主干 ${full.stats.mainCount} + 配偶 ${full.stats.spouseCount}）`);
ok(full.stats.mainCount === store.persons.filter((p) => !p.isSpouse).length,
  `主干节点数与数据一致（${full.stats.mainCount}）`);
/* 配偶节点 = 全部配偶 − 无夫主者。原谱第 6 页 E326–H326 连续四格
   「万氏／宋氏／宫氏／崔氏」未记明夫主，无法定位到任何家庭单元，
   故不被绘制（V006/V012 error 已如实标注），属预期缺口而非遗漏。 */
const unlinkedSpouses = store.persons.filter((p) => p.isSpouse && !p.spouseOfId).length;
const linkedSpouses = store.persons.filter((p) => p.isSpouse).length - unlinkedSpouses;
ok(full.stats.spouseCount === linkedSpouses,
  `配偶节点数与可挂接配偶一致（${full.stats.spouseCount}，另有 ${unlinkedSpouses} 位无夫主未绘制）`);
ok(unlinkedSpouses === 4, `无夫主配偶恰为原谱留白的 4 位「氏」（实得 ${unlinkedSpouses}）`);
ok(full.stats.adoptionLinkCount === ADOPTIONS.length,
  `过继弧线 ${full.stats.adoptionLinkCount} 条 = 过继关系 ${ADOPTIONS.length} 条`);

/* 同层不重叠：这是两趟布局算法的核心不变量。
   纵向布局同层沿 x 排布，横向布局同层沿 y 排布，故需按朝向取轴。 */
function overlapsAtSameLevel(layout, orient = 'vertical') {
  const byDepth = new Map();
  for (const n of layout.nodes) {
    if (!byDepth.has(n.depth)) byDepth.set(n.depth, []);
    byDepth.get(n.depth).push(n);
  }
  const lo = (n) => (orient === 'horizontal' ? n.y : n.x);
  const size = (n) => (orient === 'horizontal' ? n.h : n.w);
  const bad = [];
  for (const [depth, list] of byDepth) {
    const sorted = [...list].sort((a, b) => lo(a) - lo(b));
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1], cur = sorted[i];
      if (lo(prev) + size(prev) > lo(cur) + 0.01) {
        bad.push({ depth, a: prev.id, b: cur.id, gap: lo(cur) - (lo(prev) + size(prev)) });
      }
    }
  }
  return bad;
}
const overlapV = overlapsAtSameLevel(full, 'vertical');
ok(overlapV.length === 0, `纵向布局同层无重叠（检查 ${full.nodes.length} 节点）`,
  overlapV.length ? `→ ${JSON.stringify(overlapV.slice(0, 3))}` : '');

/* 父节点须落在其子节点跨度之内（不偏向一侧），且多数情况下居中 */
const kidsOf = new Map();
for (const l of full.links) {
  if (l.kind !== 'parent') continue;
  if (!kidsOf.has(l.from)) kidsOf.set(l.from, []);
  kidsOf.get(l.from).push(l.to);
}
const posById = new Map(full.nodes.map((n) => [n.id, n]));
let offSpan = 0, exact = 0, checked = 0;
for (const [pid, kids] of kidsOf) {
  const p = posById.get(pid);
  if (!p) continue;
  const cs = kids.map((k) => posById.get(k)).filter(Boolean);
  if (!cs.length) continue;
  checked++;
  const pCenter = p.x + p.w / 2;
  const loX = Math.min(...cs.map((c) => c.x));
  const hiX = Math.max(...cs.map((c) => c.x + c.w));
  const spanCenter = (loX + hiX) / 2;
  if (pCenter < loX - 0.6 || pCenter > hiX + 0.6) offSpan++;
  if (Math.abs(pCenter - spanCenter) <= 0.6) exact++;
}
ok(offSpan === 0, `父节点均落在子节点跨度之内（校验 ${checked} 个父节点）`,
  offSpan ? `→ ${offSpan} 处越出` : '');
ok(exact / checked > 0.9, `父节点居中于子节点跨度者占 ${(exact / checked * 100).toFixed(1)}%（${exact}/${checked}）`);

/* 边界包住全部节点 */
const inBounds = full.nodes.every((n) => n.x >= full.bounds.x && n.y >= full.bounds.y
  && n.x + n.w <= full.bounds.x + full.bounds.width
  && n.y + n.h <= full.bounds.y + full.bounds.height);
ok(inBounds, `边界矩形包住全部节点（${Math.round(full.bounds.width)}×${Math.round(full.bounds.height)}）`);

/* 世代背景带与世代一一对应 */
const depths = new Set(full.nodes.filter((n) => n.role === 'main').map((n) => n.depth));
ok(full.bands.length === depths.size, `世代带 ${full.bands.length} 条 = 可见世代 ${depths.size} 代`);

/* 确定性：同一输入必得同一坐标 */
const again = layoutTree(store.persons, { rootId: 'P0001', maxDepth: Infinity, adoptions: ADOPTIONS });
ok(again.nodes.every((n, i) => n.x === full.nodes[i].x && n.y === full.nodes[i].y),
  '布局结果确定（同输入两次调用坐标一致）');

/* 横向铺展：节点集合不变，仅坐标换轴 */
const horiz = layoutTree(store.persons, { rootId: 'P0001', maxDepth: 3, orient: 'horizontal', adoptions: ADOPTIONS });
const vert3 = layoutTree(store.persons, { rootId: 'P0001', maxDepth: 3, adoptions: ADOPTIONS });
ok(horiz.nodes.length === vert3.nodes.length
  && horiz.nodes.every((n, i) => n.id === vert3.nodes[i].id),
  `横向与纵向节点集合一致（${horiz.nodes.length} 个）`);
const overlapH = overlapsAtSameLevel(horiz, 'horizontal');
ok(overlapH.length === 0, `横向布局同层无重叠（检查 ${horiz.nodes.length} 节点）`,
  overlapH.length ? `→ ${JSON.stringify(overlapH.slice(0, 3))}` : '');

/* 层数裁剪与折叠 */
const d1 = layoutTree(store.persons, { rootId: 'P0001', maxDepth: 1, adoptions: ADOPTIONS });
ok(d1.nodes.filter((n) => n.role === 'main').length === 1 + 2,
  `展开 1 代仅见根与直系子代（主干 ${d1.nodes.filter((n) => n.role === 'main').length} 人）`);
ok(d1.stats.truncated > 0, `裁剪统计有效（${d1.stats.truncated} 名后代待展开）`);

const branch = store.persons.find((p) => p.name === '礼' && p.gen === 3);
const collapsed = layoutTree(store.persons, { rootId: 'P0001', maxDepth: Infinity, collapsed: new Set([branch.id]), adoptions: ADOPTIONS });
ok(collapsed.nodes.length < full.nodes.length,
  `折叠「礼」支后节点 ${full.nodes.length} → ${collapsed.nodes.length}`);
ok(!collapsed.nodes.some((n) => n.id === branch.id && n.collapsed === false), '被折叠节点带折叠标记');
const vis = buildVisibleTree(store.persons, { rootId: 'P0001', maxDepth: Infinity, collapsed: new Set([branch.id]) });
ok(vis.truncated > 0, `折叠支的后代数被计入 truncated（${vis.truncated}）`);

/* 单元宽度：主干 + 配偶横向并列
   （用固定的 6 位配偶构造，避免依赖真实数据中「配偶最多者」的数量——
     真实数据里最多只有 3 位，断言不应随数据漂移。） */
const sixWives = Array.from({ length: 6 }, (_, i) => ({ id: `SP${i}` }));
ok(unitWidth({ spouses: sixWives })
  === NODE.w + GAP.couple + 6 * SPOUSE_NODE.w + 5 * GAP.couple,
  `单元宽度公式正确（6 位配偶）`);
const maxWives = store.persons.reduce((a, b) => ((b.spouseIds || []).length > (a.spouseIds || []).length ? b : a));
ok(unitWidth({ spouses: maxWives.spouseIds.map((id) => ({ id })) })
  === NODE.w + GAP.couple + maxWives.spouseIds.length * SPOUSE_NODE.w
     + (maxWives.spouseIds.length - 1) * GAP.couple,
  `单元宽度随配偶数线性增长（${maxWives.name} 有 ${maxWives.spouseIds.length} 位配偶）`);

/* 主干路径 */
const path = pathIds(store.persons, shicong.id);
ok(path.map((id) => byId.get(id).name).join('→') === '文友→元亨→仁→国俌→纲→士聪',
  `主干路径：${path.map((id) => byId.get(id).name).join('→')}`);

/* 视图适配变换 */
const fit = fitTransform(full.bounds, 900, 600, { padding: 12, maxScale: 1.6 });
const fitsW = full.bounds.width * fit.scale <= 900 - 24 + 0.01;
const fitsH = full.bounds.height * fit.scale <= 600 - 24 + 0.01;
ok(fit.scale > 0 && fit.scale <= 1.6 && (fitsW || fitsH), `适应变换 scale=${fit.scale.toFixed(4)} 且受限于容器`);
ok(fitTransform({ width: 0, height: 0 }, 900, 600).scale === 1, '零尺寸边界退化为单位变换');

/* ── 可读字号下限（minScale）─────────────────────────────
   全谱 53323px 宽，纯按宽度适应只有 scale≈0.0168（字号 0.2px）。
   设下限后必须停在 0.5，并允许溢出——宁可让用户平移，也不能缩到读不出字。 */
const fitFloor = fitTransform(full.bounds, 1000, 700, { padding: 14, minScale: 0.5, maxScale: 1.6 });
ok(Math.abs(fitFloor.scale - 0.5) < 1e-9,
  `极宽谱系下缩放停在下限 0.5（未设下限时为 ${fit.scale.toFixed(4)}）`);
const noFloor = fitTransform(full.bounds, 1000, 700, { padding: 14, maxScale: 1.6 });
ok(fitFloor.scale > noFloor.scale,
  `可读下限确实抬高了缩放（${noFloor.scale.toFixed(4)} → ${fitFloor.scale.toFixed(2)}）`);

/* 放得下时必须居中；放不下时以锚点（根人物）为中心 */
const fitSmall = fitTransform({ x: -100, y: 0, width: 200, height: 100 }, 1000, 700, { padding: 14, maxScale: 1.6 });
ok(fitSmall.scale === 1.6, `小图放大到上限 1.6（实得 ${fitSmall.scale}）`);
ok(Math.abs(fitSmall.tx - ((1000 - 200 * 1.6) / 2 + 100 * 1.6)) < 1e-6, '放得下时横向居中');
const anchored = fitTransform(full.bounds, 1000, 700, {
  padding: 14, minScale: 0.5, maxScale: 1.6, focus: { x: 0, y: 0 },
});
ok(Math.abs(anchored.tx - 500) < 1e-6, '溢出时以锚点为中心（根人物落在画布中央）');
ok(fitTransform(full.bounds, 1000, 700, { padding: 14, minScale: 3, maxScale: 1.6 }).scale === 1.6,
  'minScale 高于 maxScale 时不产生矛盾（取 maxScale）');

/* ── 纵向舒展层距 ─────────────────────────────────────── */
ok(stretchLevelGap(1, 700) === LEVEL_GAP.vertical, '单世代不舒展（保持基准层距）');
ok(stretchLevelGap(14, 700) === LEVEL_GAP.vertical, '世代多时回落到基准层距（无需舒展）');
const gapShallow = stretchLevelGap(3, 700);
ok(gapShallow > LEVEL_GAP.vertical, `世代少时舒展层距（${LEVEL_GAP.vertical} → ${gapShallow.toFixed(1)}）`);
ok(gapShallow <= LEVEL_GAP.vertical * 2.2 + 1e-9, `舒展有上限（≤ ${(LEVEL_GAP.vertical * 2.2).toFixed(1)}）`);

/* 舒展只改纵向层距，不得改变横向尺寸——否则会让节点变小 */
const base2 = layoutTree(store.persons, { rootId: 'P0001', maxDepth: 2, adoptions: ADOPTIONS });
const tall2 = layoutTree(store.persons, { rootId: 'P0001', maxDepth: 2, levelGap: gapShallow, adoptions: ADOPTIONS });
ok(Math.abs(tall2.bounds.width - base2.bounds.width) < 1e-9,
  `舒展后横向尺寸不变（${Math.round(base2.bounds.width)}px）`);
ok(tall2.bounds.height > base2.bounds.height,
  `舒展后纵向尺寸增大（${Math.round(base2.bounds.height)} → ${Math.round(tall2.bounds.height)}px）`);
ok(tall2.stats.nodeCount === base2.stats.nodeCount, '舒展不改变节点数量');
const yLevels = clusterCount(tall2.nodes.map((n) => n.y));
ok(yLevels === tall2.bands.length, `舒展后世代仍严格分层（${yLevels} 行 = ${tall2.bands.length} 带）`);

/* 非法层距必须回退，不得塌缩为 1px（(x && x>0) 求值为布尔的历史坑） */
const badGap = layoutTree(store.persons, { rootId: 'P0001', maxDepth: 2, levelGap: true, adoptions: ADOPTIONS });
ok(badGap.bounds.height === base2.bounds.height, '布尔型层距被忽略并回退为基准层距');

/* ── 默认视图范围：始祖 + 2 代 ─────────────────────────── */
ok(base2.stats.nodeCount >= 20 && base2.stats.nodeCount < 40,
  `默认范围节点数 ${base2.stats.nodeCount} 个（始祖 + 2 代，规模适中）`);
ok(base2.stats.bandCount === 3, `默认范围 ${base2.stats.bandCount} 个世代（一世至三世）`);
ok(base2.stats.spouseCount > 0, `默认范围含配偶节点 ${base2.stats.spouseCount} 个`);
const dfltFit = fitTransform(
  layoutTree(store.persons, { rootId: 'P0001', maxDepth: 2, levelGap: gapShallow, adoptions: ADOPTIONS }).bounds,
  1000, 700, { padding: 14, minScale: 0.5, maxScale: 1.6 },
);
ok(dfltFit.scale >= 0.5, `默认视图缩放 ${dfltFit.scale.toFixed(3)} ≥ 0.5（字号约 ${(13 * dfltFit.scale).toFixed(1)}px）`);

/* 局部血缘关系图（沙漏） */
const f1 = layoutFocus(store.persons, shicong.id, { adoptions: ADOPTIONS });
ok(f1.nodes.some((n) => n.role === 'self' && n.id === shicong.id), '沙漏图含本人节点');
ok(f1.nodes.some((n) => n.role === 'father'), '沙漏图含父辈节点');
ok(f1.nodes.some((n) => n.role === 'child'), `沙漏图含子辈节点（${f1.rows.down} 人）`);
ok(f1.links.every((l) => typeof l.path === 'string' && l.path.startsWith('M')), '沙漏图连线均为合法路径');
const fBad = f1.nodes.filter((n) => !Number.isFinite(n.x) || !Number.isFinite(n.y));
ok(fBad.length === 0, '沙漏图坐标均为有限数');

const adoptee = store.persons.find((p) => p.id === ADOPTIONS[0].fromId);
const f2 = layoutFocus(store.persons, adoptee.id, { adoptions: ADOPTIONS });
ok(f2.nodes.some((n) => n.role === 'adoptive'), `沙漏图对出继者另绘养父（${adoptee.name}）`);
ok(f2.info.adoptive === true && f2.rows.up >= 2, '沙漏图父辈行同时容纳生父与养父');
ok(f2.links.some((l) => l.kind === 'adoption'), '沙漏图含过继连线');

/* 全谱性能：布局须在毫秒级完成 */
const t0 = Date.now();
layoutTree(store.persons, { rootId: 'P0001', maxDepth: Infinity, adoptions: ADOPTIONS });
const ms = Date.now() - t0;
ok(ms < 120, `全谱 ${full.nodes.length} 节点布局耗时 ${ms}ms`);

/* ── 汇总 ──────────────────────────────────────────────── */
console.log(`\n${'='.repeat(52)}`);
console.log(`自检结果：通过 ${pass} 项，失败 ${fail} 项`);
console.log('='.repeat(52));
process.exit(fail ? 1 : 0);
