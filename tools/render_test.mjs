/**
 * render_test.mjs — 端到端渲染自检（jsdom）
 * ---------------------------------------------------------------
 * 在真实 DOM 实现中加载 index.html，导入 app.js，验证：
 *   · 启动无异常，导航与视图根节点完成渲染；页面标题为「孙氏族谱」
 *   · 六个视图（概览/谱系图/名录/文献/校验/权限）均可切换并产出内容；默认落点为「概览」
 *   · 谱系图：SVG 图形真实产出（世代带、连线、节点、过继弧线）、
 *             节点点击联动档案栏、深度/方向/模式切换、过继信息可读
 *   · 谱系图触屏：按图形是否纵向溢出动态接管手势，放大后单指横纵自由平移
 *   · 名录：默认「世系树」并展开全部世代；检索自动切列表并收敛结果
 *   · 首页：原籍介绍可展开《前言》全文；「使用说明」弹窗覆盖各模块；
 *           入口按角色收敛（访客把治理类模块收进「其他权限」折叠组）
 *   · 各页底部「快速跳转」条：六视图全覆盖、不列自身、可实际跨页导航
 *   · 检索、角色切换（含口令闸门）、主题切换等关键交互生效
 *   · 不同角色下的写操作按钮可用性符合权限矩阵
 *
 * 依赖 jsdom（仅开发期，不入站）：
 *   cd ~/.workbuddy-ai/binaries/node/workspace && npm i jsdom
 * 运行：
 *   SUNCLAN_JSDOM_HOME=<...>/node/workspace node tools/render_test.mjs
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * jsdom 仅作为开发期依赖，不入站、不污染站点目录。
 * 解析顺序：环境变量 SUNCLAN_JSDOM_HOME → 隔离的 Node 工作区 → 站点本地 node_modules。
 */
const require = createRequire(import.meta.url);
const JSDOM_HOMES = [
  process.env.SUNCLAN_JSDOM_HOME,
  process.env.HOME ? join(process.env.HOME, '.workbuddy-ai/binaries/node/workspace') : null,
  process.env.USERPROFILE ? join(process.env.USERPROFILE, '.workbuddy-ai/binaries/node/workspace') : null,
  ROOT,
].filter(Boolean);

let JSDOM = null;
for (const home of JSDOM_HOMES) {
  try {
    const mod = await import(pathToFileURL(require.resolve('jsdom', { paths: [home] })).href);
    JSDOM = mod.JSDOM || mod.default?.JSDOM;
    if (JSDOM) break;
  } catch { /* 换下一个候选目录 */ }
}
if (!JSDOM) {
  console.log('\n  ⚠ 未找到 jsdom，跳过渲染自检。');
  console.log('    安装：cd ~/.workbuddy-ai/binaries/node/workspace && npm i jsdom\n');
  process.exit(0);
}

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label} ${extra}`); }
};
const section = (t) => console.log(`\n── ${t} ──`);
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/* ── 1. 构建 DOM 环境 ──────────────────────────────────── */
const html = await readFile(join(ROOT, 'index.html'), 'utf8');
const dom = new JSDOM(html, {
  url: 'http://127.0.0.1:5173/',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});

const { window } = dom;
for (const k of [
  'window', 'document', 'navigator', 'location', 'history', 'localStorage', 'sessionStorage',
  'HTMLElement', 'Element', 'Node', 'CustomEvent', 'Event', 'Blob', 'FileReader', 'DOMParser',
  'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'matchMedia',
]) {
  if (window[k] === undefined) continue;
  try {
    globalThis[k] = window[k];
  } catch {
    // Node 内建了只读全局（如 navigator），改用 defineProperty 覆盖
    Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true });
  }
}
globalThis.URL = window.URL;
window.scrollTo = () => {};
window.confirm = () => true;
// jsdom 未实现滚动相关 API，站点在选中人物时会调用，这里做最小替身
window.Element.prototype.scrollIntoView = () => {};
window.HTMLElement.prototype.scrollIntoView = () => {};

/* 谱系图画布在 jsdom 中没有真实布局（clientWidth/Height 恒为 0），
   显式给出一个真实浏览器尺度的画布，使「默认适应缩放」的断言有意义。
   只对 .chart-canvas 生效，避免影响其他视图按高度分页的逻辑。 */
const CANVAS_W = 1000;
const CANVAS_H = 700;
for (const prop of ['clientWidth', 'clientHeight']) {
  Object.defineProperty(window.Element.prototype, prop, {
    configurable: true,
    get() {
      if (this.classList?.contains('chart-canvas')) {
        return prop === 'clientWidth' ? CANVAS_W : CANVAS_H;
      }
      return 0;
    },
  });
}

/* ── 2. 启动应用 ──────────────────────────────────────── */
section('启动与首屏');
let app;
let authMod;
try {
  app = await import(pathToFileURL(join(ROOT, 'assets', 'js', 'app.js')).href);
  ok(true, 'app.js 导入并执行 boot() 无异常');
  authMod = await import(pathToFileURL(join(ROOT, 'assets', 'js', 'core', 'auth.js')).href);
} catch (e) {
  ok(false, 'app.js 导入失败', `\n      ${e.stack?.split('\n').slice(0, 3).join('\n      ')}`);
  console.log(`\n  渲染自检中断：通过 ${pass}，失败 ${fail}\n`);
  process.exit(1);
}

const $ = (s) => window.document.querySelector(s);
const $$ = (s) => [...window.document.querySelectorAll(s)];
const root = $('#view-root');
/** 当前视图：go() 会把视图键写入 location.hash */
const currentViewKey = () => String(window.location.hash || '').replace(/^#/, '');

ok(!!root, '存在视图根节点 #view-root');
ok($$('#nav .nav-item').length === 6, `导航项 ${$$('#nav .nav-item').length} 个（期望 6）`);
ok(/id="rev-label"/.test(html) && $('#rev-label').textContent.includes('修订'), `修订标签：${
  $('#rev-label').textContent.trim()}`);
ok(root.textContent.includes('孙氏族谱') || /谱系图|图例/.test(root.textContent), '首屏含谱名或图形视图标记');
/* 默认落点与导航次序为产品约定：进入站点即「概览」，其次「谱系图」。
 * 此处锁定，防止后续重构无意间改回首屏直接进图形视图。 */
ok(currentViewKey() === 'home', `默认进入「概览」（hash=${currentViewKey() || '（空）'}）`);
ok($$('#nav .nav-item').map((b) => b.dataset.key).slice(0, 2).join(',') === 'home,chart',
  `导航前两位为 概览→谱系图（实际 ${$$('#nav .nav-item').map((b) => b.dataset.key).slice(0, 2).join('→')}）`);
ok($('#nav .nav-item.is-active')?.dataset.key === 'home', '默认高亮项为「概览」');

/* 站名约定：页面标题仅为「孙氏族谱」，不带「中秋」字样。
   注：作者署名原文中的「中秋」属作者自撰内容，不在收敛范围内。 */
const titleTag = ((html.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '').trim();
ok(titleTag === '孙氏族谱', `页面标题为「孙氏族谱」（实际「${titleTag}」）`);
const descTag = (html.match(/<meta name="description" content="([^"]*)"/) || [])[1] || '';
ok(!/中秋/.test(titleTag) && !/中秋/.test(descTag), '标题与描述中不含「中秋」字样');

/* ── 3. 六视图切换（顺序与导航一致：概览 → 谱系图 → …） ── */
section('视图切换');
const VIEW_KEYS = ['home', 'chart', 'explore', 'docs', 'validate', 'admin'];
const VIEW_MARK = {
  chart: '图例',
  home: '孙氏族谱',
  explore: '世系',
  docs: '版本沿革',
  validate: '校验',
  admin: '权限',
};
for (const key of VIEW_KEYS) {
  let threw = null, len = 0, text = '';
  try {
    app.go(key);
    len = root.innerHTML.length;
    text = root.textContent;
  } catch (e) { threw = e; }
  ok(!threw && len > 800 && text.includes(VIEW_MARK[key]),
    `视图 ${key} 渲染正常（${len} 字符）`,
    threw ? `→ ${threw.message}` : `→ 缺少标记「${VIEW_MARK[key]}」`);
}

/* ── 4. 谱系图：图形真实产出 ───────────────────────────── */
section('谱系图（主视图）');
app.go('chart');
const chartSvg = $('#view-root svg.gc-svg');
ok(!!chartSvg, 'SVG 图形元素已生成');
ok(!!$('#view-root .chart-toolbar') && !!$('#view-root .chart-status') && !!$('#view-root .chart-legend'),
  '工具条 / 状态栏 / 图例齐备');

/* 从 .gc-root 的 transform 中读出当前缩放比例 */
const gcScale = () => {
  const t = $('#view-root .gc-root')?.getAttribute('transform') || '';
  const m = /scale\(([\d.]+)\)/.exec(t);
  return m ? +m[1] : 0;
};
/* 把一组坐标按容差聚类，用于判断「有多少个不同的世代行 / 横向位置」 */
const clusterCount = (vals, tol = 8) => {
  const s = [...new Set(vals)].sort((a, b) => a - b);
  let n = 0, last = -Infinity;
  for (const v of s) { if (v - last > tol) { n += 1; last = v; } }
  return n;
};
const nodeXY = () => $$('#view-root .gc-node').map((n) => {
  const m = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(n.getAttribute('transform') || '');
  return m ? { x: +m[1], y: +m[2] } : null;
}).filter(Boolean);

const nodeCount = $$('#view-root .gc-node').length;
const bandCount = $$('#view-root .gc-band').length;
ok(nodeCount >= 20, `默认节点数 ${nodeCount} 个（始祖 + 2 代）`);
ok(bandCount >= 3, `世代背景带 ${bandCount} 条`);

/* ── 默认视图三要素：纵向铺展 · 显示配偶 · 可读字号 ── */
const btnText = () => $$('#view-root .chart-toolbar button').map((b) => b.textContent).join('|');
ok(/方向：纵向/.test(btnText()), '默认方向为纵向（世代自上而下）');

ok($$('#view-root .gc-node--spouse').length > 0,
  `默认显示配偶节点 ${$$('#view-root .gc-node--spouse').length} 个`);
ok(/配偶：显示/.test(btnText()), '默认配偶为「显示」而非隐藏');
ok($$('#view-root .gc-link--spouse').length > 0, '存在配偶虚线');

// 纵向的判据：同世同 y、异世异 y —— 世代必须沿竖直方向堆叠
const xy = nodeXY();
ok(clusterCount(xy.map((p) => p.y)) === bandCount,
  `世代沿竖直方向堆叠（${clusterCount(xy.map((p) => p.y))} 行 = ${bandCount} 条世代带）`);
ok(clusterCount(xy.map((p) => p.x)) > bandCount,
  `同一世代内横向并列（${clusterCount(xy.map((p) => p.x))} 列 > ${bandCount} 行）`);

// 默认缩放不得低于可读字号下限
ok(gcScale() >= 0.5, `默认缩放 ${gcScale().toFixed(3)} ≥ 0.5（字号约 ${(13 * gcScale()).toFixed(1)}px）`);

// 世代带标注
ok($$('#view-root .gc-band-label').length === bandCount, '每条世代带均有标注');
ok(/一世/.test($$('#view-root .gc-band-label').map((e) => e.textContent).join('|')),
  '世代带标注含「一世」');

// 连线证据分色：默认范围内前 3 世均为《前言》明载，故先验「明载」实线
ok($$('#view-root .gc-link--doc').length + $$('#view-root .gc-link--spine').length > 0,
  '存在「明载」实线');

// 展开层数切换应改变可见节点数（默认 2 代）
const depthSel = $$('#view-root .chart-toolbar select')[1];
if (depthSel) {
  const n0 = nodeCount;
  depthSel.value = '4';
  depthSel.dispatchEvent(new window.Event('change', { bubbles: true }));
  await tick();
  const n4 = $$('#view-root .gc-node').length;
  ok(n4 > n0, `展开层数由 2 增为 4：节点 ${n0} → ${n4}`);
  ok($$('#view-root .gc-link--heuristic').length > 0, '展开后出现「推导待核」虚线');

  // 4 代时整树宽 8846px：若按宽度硬缩会得到 scale≈0.109、字号 1.4px。
  // 有可读字号下限后，缩放不得跌破 0.5，代价是溢出画布并由用户平移。
  ok(gcScale() >= 0.5, `展开 4 代后缩放 ${gcScale().toFixed(3)} 仍不低于可读下限 0.5`);
  ok(/超出画布/.test($('#view-root .chart-status')?.textContent || ''),
    '图形超出画布时状态栏给出平移提示');

  depthSel.value = '2';
  depthSel.dispatchEvent(new window.Event('change', { bubbles: true }));
  await tick();
  ok($$('#view-root .gc-node').length === n0, `收回 2 代：节点回到 ${n0}`);
}

// 方向切换
const orientBtn = $$('#view-root .chart-toolbar button').find((b) => /方向：/.test(b.textContent));
if (orientBtn) {
  orientBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick();
  ok(/方向：横向/.test($$('#view-root .chart-toolbar button').map((b) => b.textContent).join('|'))
    && $$('#view-root .gc-node').length > 0, '切换为横向铺展后仍正常渲染');
  orientBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick();
  ok(/方向：纵向/.test($$('#view-root .chart-toolbar button').map((b) => b.textContent).join('|')), '切回纵向');
}

// 配偶显隐
const spouseBtn = $$('#view-root .chart-toolbar button').find((b) => /配偶：/.test(b.textContent));
if (spouseBtn) {
  const withSpouse = $$('#view-root .gc-node').length;
  spouseBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick();
  ok($$('#view-root .gc-node').length < withSpouse, '隐藏配偶后节点减少');
  spouseBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick();
}

// 节点点击 → 档案栏（先把展开层数放到「全部」，确保第 6 世人物在图中）
const depthSel2 = $$('#view-root .chart-toolbar select')[1];
depthSel2.value = 'Infinity';
depthSel2.dispatchEvent(new window.Event('change', { bubbles: true }));
await tick();
ok($$('#view-root .gc-node').length > 1000, `展开全部世代后节点 ${$$('#view-root .gc-node').length} 个`);

const target = app.store.persons.find((p) => p.name === '士聪' && p.gen === 6)
  || app.store.persons.find((p) => !p.isSpouse && p.gen === 6);
app.pick(target.id);
await tick();
const nodeEl = $(`#view-root .gc-node[data-id="${target.id}"]`);
ok(!!nodeEl, `图形中存在「${target.name}」节点`);
nodeEl?.dispatchEvent(new window.Event('click', { bubbles: true }));
await tick();
const aside = $('#view-root .chart-aside');
ok(!!aside && aside.innerHTML.length > 200, '点击节点后档案栏已渲染');
ok(new RegExp(target.name).test(aside?.textContent || ''), `档案栏显示「${target.name}」`);
ok(/世系路径/.test(aside?.textContent || ''), '档案栏含世系路径');
ok($$('#view-root .gc-node.is-focus').length === 1, '被选中节点获得聚焦态');

/* ── 5. 谱系图：血缘关系图（沙漏）与过继 ───────────────── */
section('血缘关系图与过继');
const modeBtn = $$('#view-root .chart-toolbar button').find((b) => /切到：/.test(b.textContent));
if (modeBtn) {
  modeBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick();
  ok(!!$('#view-root .gc-node--self'), '血缘关系图含「本人」节点');
  ok($$('#view-root .gc-link-label').length > 0, `边上标注亲属称谓 ${$$('#view-root .gc-link-label').length} 处`);
  modeBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick();
  ok(!$('#view-root .gc-node--self'), '切回世系树');
}

// 过继：言昌（P0155）生父士茂、养父士学，fatherId 为生父，养父须另立关系
const adopt = app.store.adoptions[0];
// 断言「去重」而非硬编码条数：随原谱转录细化，过继关系数会变；
// 真正的不变量是——每条关系自洽（from≠to）且 (fromId,toId) 组合唯一。
ok(app.store.adoptions.length > 0, `过继关系 ${app.store.adoptions.length} 条`);
const adoptKeys = new Set(app.store.adoptions.map((a) => `${a.fromId}->${a.toId}`));
ok(
  adoptKeys.size === app.store.adoptions.length,
  `过继关系 (fromId,toId) 组合唯一（${adoptKeys.size}/${app.store.adoptions.length}）`,
);
ok(
  app.store.adoptions.every((a) => a.fromId && a.toId && a.fromId !== a.toId),
  '过继关系自洽（出继人 ≠ 承继人）',
);
const adoptee = app.store.persons.find((p) => p.id === adopt.fromId);
ok(adoptee && adoptee.fatherId !== adopt.toId, `「${adoptee?.name}」的 fatherId 为生父而非养父（模型正确）`);
app.pick(adopt.fromId);
await tick();
const adText = $('#view-root .chart-aside')?.textContent || '';
ok(/出继/.test(adText), '档案栏标出「出继」');
ok(/过继给/.test(adText), '档案栏给出养父去向');

// 过继弧线：以养父为根展开时，应出现 gc-link--adopt
const adopter = app.store.persons.find((p) => p.id === adopt.toId);
const rootSel = $$('#view-root .chart-toolbar select')[0];
if (adopter && rootSel && [...rootSel.options].some((o) => o.value === adopter.id)) {
  rootSel.value = adopter.id;
  rootSel.dispatchEvent(new window.Event('change', { bubbles: true }));
  await tick();
  ok($$('#view-root .gc-link--adopt').length > 0 || $$('#view-root .gc-node.is-adopted-in').length > 0,
    '以养父为根时绘出过继关系');
} else {
  // 养父多为中世代人物，不在根下拉中；改用根为始祖 + 足够深度覆盖
  rootSel.value = 'P0001';
  rootSel.dispatchEvent(new window.Event('change', { bubbles: true }));
  const dSel = $$('#view-root .chart-toolbar select')[1];
  if (dSel) { dSel.value = 'Infinity'; dSel.dispatchEvent(new window.Event('change', { bubbles: true })); }
  await tick();
  ok($$('#view-root .gc-link--adopt').length > 0, `全谱展开后绘出过继弧线 ${$$('#view-root .gc-link--adopt').length} 条`);
}

// 折叠交互
rootSel.value = 'P0001';
rootSel.dispatchEvent(new window.Event('change', { bubbles: true }));
await tick();
const toggles = $$('#view-root .gc-toggle');
ok(toggles.length > 0, `存在折叠控制钮 ${toggles.length} 个`);
if (toggles.length) {
  const before = $$('#view-root .gc-node').length;
  toggles[0].dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick();
  ok($$('#view-root .gc-node').length < before, '折叠后可见节点减少');
  ok($$('#view-root .gc-toggle.is-collapsed').length > 0, '折叠钮进入折叠态并显示后代计数');
  $$('#view-root .gc-toggle.is-collapsed')[0]
    .dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick();
  ok($$('#view-root .gc-node').length === before, '展开后节点数复原');
}

// 缩放按钮
const zoomIn = $$('#view-root .chart-toolbar button').find((b) => b.textContent.trim() === '＋');
if (zoomIn) {
  const g0 = $('#view-root .gc-root').getAttribute('transform');
  zoomIn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick();
  ok($('#view-root .gc-root').getAttribute('transform') !== g0, '缩放按钮改变了视图变换');
}

/* ── 5b. 谱系图：触屏平移（放大后仍可自由拖动） ─────────── */
/* 曾经的缺陷：`.chart-canvas` 固定 touch-action: pan-y，纵向手势一旦被判给
   页面滚动，后续 touchmove 变为不可取消，preventDefault 失效 —— 表现就是
   「手机上放大谱系图后拖不动」。现在按图形是否纵向溢出动态切换 touch-action。 */
section('谱系图触屏平移');
{
  const canvasEl = $('#view-root .chart-canvas');
  /* 每次 renderGraph 都会重建 <svg>，旧引用会变成游离节点——
     事件必须派发到**当前**的 svg 上，故一律现取。 */
  const svgOf = () => $('#view-root .gc-svg');
  const readTf = () => {
    const m = /translate\(([-\d.eE]+)[ ,]([-\d.eE]+)\)\s*scale\(([-\d.eE]+)\)/
      .exec($('#view-root .gc-root')?.getAttribute('transform') || '');
    return m ? { tx: +m[1], ty: +m[2], scale: +m[3] } : null;
  };
  const mkTouch = (type, pts) => {
    const e = new window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'touches', { value: pts, configurable: true });
    Object.defineProperty(e, 'changedTouches', { value: pts, configurable: true });
    return e;
  };
  const drag = (from, to) => {
    const svg = svgOf();
    svg.dispatchEvent(mkTouch('touchstart', [from]));
    svg.dispatchEvent(mkTouch('touchmove', [to]));
    const tf = readTf();
    svg.dispatchEvent(mkTouch('touchend', []));
    return tf;
  };
  const chartDepth = $$('#view-root .chart-toolbar select')[1];
  const fitBtn = $$('#view-root .chart-toolbar button').find((b) => b.textContent.trim() === '适应');

  // (1) 未溢出：横向可平移，纵向交还页面滚动
  chartDepth.value = '2';
  chartDepth.dispatchEvent(new window.Event('change', { bubbles: true }));
  await tick();
  fitBtn?.dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick();
  ok(canvasEl.style.touchAction === 'pan-y',
    `图形未纵向溢出时保留页面纵向滚动（touch-action=${canvasEl.style.touchAction || '（未设置）'}）`);
  const hBefore = readTf();
  const hAfter = drag({ clientX: 300, clientY: 300 }, { clientX: 430, clientY: 300 });
  ok(hAfter && hBefore && hAfter.tx !== hBefore.tx,
    `未溢出时横向拖动可平移（Δtx=${hBefore && hAfter ? (hAfter.tx - hBefore.tx).toFixed(1) : '—'}）`);
  const vBefore = readTf();
  const vAfter = drag({ clientX: 300, clientY: 300 }, { clientX: 300, clientY: 430 });
  ok(vAfter && vBefore && vAfter.ty === vBefore.ty, '未溢出时纵向拖动不平移图形（让位给页面滚动）');

  // (2) 放大到纵向溢出：纵向手势归图形，横纵自由平移
  chartDepth.value = 'Infinity';
  chartDepth.dispatchEvent(new window.Event('change', { bubbles: true }));
  await tick();
  const zoomUp = $$('#view-root .chart-toolbar button').find((b) => b.textContent.trim() === '＋');
  for (let i = 0; i < 4; i += 1) zoomUp?.dispatchEvent(new window.Event('click', { bubbles: true }));
  await tick();
  ok(canvasEl.style.touchAction === 'none',
    `图形纵向溢出后画布接管手势（touch-action=${canvasEl.style.touchAction || '（未设置）'}）`);

  const tp2 = readTf();
  const tp3 = drag({ clientX: 300, clientY: 300 }, { clientX: 300, clientY: 430 });
  ok(tp3 && tp2 && tp3.ty !== tp2.ty,
    `放大溢出后纵向拖动可平移图形（Δty=${tp2 && tp3 ? (tp3.ty - tp2.ty).toFixed(1) : '—'}）`);

  // 手势一经锁定，斜向拖动应横纵同时生效（不再被轴锁限制）
  const svgNow = svgOf();
  svgNow.dispatchEvent(mkTouch('touchstart', [{ clientX: 300, clientY: 300 }]));
  svgNow.dispatchEvent(mkTouch('touchmove', [{ clientX: 330, clientY: 360 }]));
  const tpA = readTf();
  svgNow.dispatchEvent(mkTouch('touchmove', [{ clientX: 400, clientY: 500 }]));
  const tpB = readTf();
  ok(tpA && tpB && tpB.tx !== tpA.tx && tpB.ty !== tpA.ty, '手势锁定后斜向拖动横纵同时平移');
  svgNow.dispatchEvent(mkTouch('touchend', []));

  // 复原到默认展开始祖以下 2 代，避免影响后续断言
  chartDepth.value = '2';
  chartDepth.dispatchEvent(new window.Event('change', { bubbles: true }));
  await tick();
}

/* ── 5c. 名录：默认「世系树」并展开全部世代 ────────────── */
section('名录默认视图');
app.go('explore');
await tick();
const segBtns = $$('#view-root .seg button');
ok(segBtns[1]?.classList.contains('is-on') && !segBtns[0]?.classList.contains('is-on'),
  `默认选中「${segBtns[1]?.textContent.trim()}」`);
const exploreCols = $$('#view-root .split > div')[0];
ok(exploreCols?.children[0]?.hidden === true, '列表视图默认隐藏');
ok(exploreCols?.children[1]?.hidden === false, '世系树默认显示');
const treeNodes = $$('#view-root .tnode');
ok(treeNodes.length > 1000, `世系树默认展开渲染 ${treeNodes.length} 个节点`);
const shownGens = new Set($$('#view-root .tnode__meta')
  .map((n) => n.textContent.trim())
  .filter((t) => /^[一二三四五六七八九十]+世$/.test(t)));
const totalGens = new Set(app.store.persons.map((p) => p.gen)).size;
ok(shownGens.size >= totalGens,
  `默认展开覆盖 ${shownGens.size} 个世代（全谱 ${totalGens} 世）`);
const treeBtns = $$('#view-root .tree, #view-root .card__head button').map((b) => b.textContent.trim());
ok(treeBtns.includes('全部展开') && treeBtns.includes('全部折叠'), '世系树提供「全部展开／全部折叠」');

/* ── 6. 名录检索交互 ───────────────────────────────────── */
section('名录检索交互');
const search = $('#view-root input.input--search');
ok(!!search, '存在检索输入框');
const beforeCount = $$('#view-root .pitem').length;
if (search) {
  search.value = '士聪';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  await tick(320); // 输入框为 180ms 防抖
  const afterCount = $$('#view-root .pitem').length;
  ok(afterCount > 0 && afterCount < beforeCount,
    `检索「士聪」后列表由 ${beforeCount} 条收敛为 ${afterCount} 条`);
  ok(/士聪/.test(root.textContent), '结果中出现「士聪」');
  ok(/#explore-count/.test(html) || /命中/.test(root.textContent), '展示命中计数');
  search.value = '';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  await tick(320);
  ok($$('#view-root .pitem').length === beforeCount, `清空检索后恢复 ${beforeCount} 条`);
}

/* ── 7. 名录：人物详情与关系 ───────────────────────────── */
section('人物详情与关系');
const shicong = app.store.persons.find((p) => p.name === '士聪' && p.gen === 6);
app.pick(shicong.id, { view: 'explore' });
await tick();
const asideE = $('#view-root .split__aside');
ok(!!asideE && asideE.innerHTML.length > 100, '名录详情侧栏已渲染');
ok(/士聪/.test(asideE?.textContent || ''), '详情面板显示「士聪」');
ok(/世系路径/.test(asideE?.textContent || ''), '详情面板含世系路径');
ok($$('#view-root .pitem.is-selected').length === 1,
  '列表中自动翻页并高亮所选人物',
  `→ 选中 ${$$('#view-root .pitem.is-selected').length} 项`);
ok(/纲/.test(asideE?.textContent || ''), '详情面板含父系关联人物「纲」');
ok(/子女/.test(asideE?.textContent || ''), '详情面板含子女区块');

/* ── 8. 角色与权限联动 ─────────────────────────────────── */
section('角色与权限联动');
const roleSel = $('#role-select');
ok(!!roleSel, '存在角色选择器');
const btnNamed = (n) => $$('#view-root .split__aside button').find((b) => b.textContent.trim() === n);

app.auth.setRole('guest');
app.pick(shicong.id, { view: 'explore' });
await tick();
ok(btnNamed('编辑')?.disabled === true, '访客角色：编辑按钮禁用');
ok(btnNamed('添子')?.disabled === true, '访客角色：添子按钮禁用');

app.auth.setRole('editor');
app.pick(shicong.id, { view: 'explore' });
await tick();
ok(btnNamed('编辑')?.disabled === false, '编修角色：编辑按钮可用');
ok(btnNamed('删除')?.disabled === true, '编修角色：删除按钮禁用');

app.auth.setRole('elder');
app.pick(shicong.id, { view: 'explore' });
await tick();
ok(btnNamed('删除')?.disabled === false, '族老角色：删除按钮可用');

app.auth.setRole('admin');
app.pick(shicong.id, { view: 'explore' });
await tick();
ok(btnNamed('删除')?.disabled === false, '管理员角色：删除按钮可用');
app.auth.setRole('guest');

/* ── 8b. 角色口令闸门 ─────────────────────────────────── */
/* 访客免口令；切到任何非访客角色都须输入口令。闸门位于 UI 入口
   （ui/roleGate.js），auth.setRole 仍是不过闸的低层原语——上面 8 节正因如此
   才能直接调它。本节的目的是锁住「界面入口不能绕过口令」这一约定。 */
section('角色口令闸门');
const { Auth } = authMod;
const gateOverlay = () => document.querySelector('.modal-overlay');
const gateInput = () => document.querySelector('.modal-overlay .modal__body input');
const gateErr = () => document.querySelector('.modal-overlay .field__error');
const gateBtn = (label) => [...document.querySelectorAll('.modal-overlay .modal__footer button')]
  .find((b) => b.textContent.trim() === label);
const switchTo = async (key) => {
  roleSel.value = key;
  roleSel.dispatchEvent(new window.Event('change'));
  await tick();
};

Auth.lockSession();
app.auth.setRole('guest');
await tick();

await switchTo('admin');
ok(!!gateOverlay(), '切到「管理员」时弹出需口令对话框');
ok(app.auth.role === 'guest', `口令未通过前角色仍为访客（实际 ${app.auth.role}）`);
ok(roleSel.value === 'guest', '下拉框复位为当前角色，不停留在未授权项');

gateInput().value = '000000';
gateBtn('确定').click();
await tick();
ok(!!gateOverlay(), '口令错误时对话框保持打开');
ok(app.auth.role === 'guest', '口令错误时角色不变');
ok(/不正确/.test(gateErr()?.textContent || ''), '给出「口令不正确」提示');

gateInput().value = '888888';
gateBtn('确定').click();
await tick();
ok(!gateOverlay(), '口令正确后对话框自动关闭');
ok(app.auth.role === 'admin', `口令正确后切换到管理员（实际 ${app.auth.role}）`);

await switchTo('guest');
ok(!gateOverlay(), '切回「访客」不弹口令框（访客免口令）');
ok(app.auth.role === 'guest', '切回访客立即生效');
ok(Auth.isUnlocked() === false, '回到访客后本会话解锁标记被清除');

await switchTo('editor');
ok(!!gateOverlay(), '回到访客后再切非访客，重新要求口令');
gateBtn('取消').click();
await tick();
ok(app.auth.role === 'guest', '取消后仍为访客');
ok(!gateOverlay(), '取消后对话框关闭');

/* 本会话内已解锁后，非访客之间互切不再重复索要口令 */
await switchTo('elder');
gateInput().value = '888888';
gateBtn('确定').click();
await tick();
ok(app.auth.role === 'elder', '口令通过后进入族老');
await switchTo('admin');
ok(!gateOverlay(), '同一会话内已解锁，非访客之间互切不再弹口令框');
ok(app.auth.role === 'admin', `互切到管理员（实际 ${app.auth.role}）`);

/* 启动时不得凭本地持久化的角色直接进入：模拟「存过 admin 但本会话未解锁」 */
Auth.lockSession();
ok(Auth.restoreRole('admin') === 'guest', '本会话未解锁时，持久化的 admin 被回落为访客');
Auth.unlockSession();
ok(Auth.restoreRole('admin') === 'admin', '本会话已解锁时，持久化的 admin 可被恢复');
ok(Auth.restoreRole('guest') === 'guest', '持久化为访客时始终回落访客');
Auth.lockSession();
app.auth.setRole('guest');
await tick();

/* ── 9. 主题切换 ───────────────────────────────────────── */
section('主题切换');
const themeBtn = $('#theme-toggle');
const t0 = window.document.documentElement.dataset.theme;
themeBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
const t1 = window.document.documentElement.dataset.theme;
ok(t0 !== t1, `主题由 ${t0} 切换为 ${t1}`);
themeBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
ok(window.document.documentElement.dataset.theme === t0, '再次点击切回原主题');

/* ── 10. 校验中心内容 ──────────────────────────────────── */
section('校验中心');
app.go('validate');
const vt = root.textContent;
ok(/24|规则/.test(vt), '展示规则目录');
ok(/G-|R-|F-/.test(vt), '展示规则编号');
ok($$('#view-root .rule-item').length > 0, `列出校验问题条目 ${$$('#view-root .rule-item').length} 条`);
ok($$('#view-root .tbl tr').length > 3, `规则一览表 ${$$('#view-root .tbl tr').length} 行`);
ok(/独立交叉校验/.test(vt), '展示「独立交叉校验」区块');
ok(/C01/.test(vt) && /C12/.test(vt), '列出 C01–C12 独立校验项');
ok(/R-SPOUSE-EXCLUSIVE/.test(vt), '口径说明含配偶字段互斥规则');
ok(/过继/.test(vt), '口径说明含过继处理约定');
ok($$('#view-root .stat').length >= 8, `校验中心统计卡 ${$$('#view-root .stat').length} 张（运行时 4 + 独立校验 4）`);

/* ── 11. 概览的独立校验摘要 ────────────────────────────── */
section('概览');
app.go('home');
ok(/独立交叉校验/.test(root.textContent), '概览含独立交叉校验摘要');
ok($$('#view-root .stat').length >= 12, `概览统计卡 ${$$('#view-root .stat').length} 张`);
ok(/文友/.test(root.textContent), '概览含一世祖「文友」主脉');
ok(/e308abe6c2974adcf33038818126c7baeb31456531077959b074b71a95945060/i.test(root.textContent)
  || /sha256|SHA-256|指纹/i.test(root.textContent), '概览展示来源指纹');
ok($$('#view-root .card').length >= 7, `支系区块卡 ${$$('#view-root .card').length} 张`);

/* ── 11.2 首页重构：检索、入口、作者说明 ───────────────── */
section('首页重构');
app.go('home');
const qf = $('#view-root .quickfind__input');
ok(!!qf, '首页顶部存在快速检索框');
if (qf) {
  qf.value = '士仁';
  qf.dispatchEvent(new window.Event('input', { bubbles: true }));
  await tick(60);
  const hits = $$('#view-root .quickfind__hit').length;
  ok(hits > 0, `输入「士仁」即时命中 ${hits} 条（无需跳转）`);
  ok(/士仁/.test($('#view-root .quickfind__results')?.textContent || ''), '结果区显示「士仁」');
  qf.value = 'zzz不存在的人';
  qf.dispatchEvent(new window.Event('input', { bubbles: true }));
  await tick(60);
  ok(!!$('#view-root .quickfind__empty'), '无命中时给出明确空态提示');
  qf.value = '';
  qf.dispatchEvent(new window.Event('input', { bubbles: true }));
  await tick(60);
  ok($('#view-root .quickfind__results')?.hidden === true, '清空后结果区收起');
}
const entries = $$('#view-root .entry');
ok(entries.length >= 6, `首页功能入口卡 ${entries.length} 张（期望 ≥6）`);
ok(/从这里开始/.test(root.textContent), '首页含「从这里开始」入口区');
const entryText = entries.map((b) => b.textContent).join('|');
for (const mark of ['谱系图', '名录', '文献', '校验', '凡字', '权限']) {
  ok(entryText.includes(mark), `入口覆盖「${mark}」`);
}
/* 「谱牒文献」须排在该区域最顶部：它是本站的原始史料，应先于一切派生视图被看到 */
const firstEntry = entries[0]?.textContent || '';
ok(/谱牒文献/.test(firstEntry),
  `「从这里开始」首项为「谱牒文献」（实际首项：${firstEntry.trim().slice(0, 12)}）`);
ok(!/谱系图|名录检索/.test(firstEntry), '谱系图/名录不再占据首位');
ok($$('#view-root .entry__icon svg').length >= 6, '入口卡均带图标');
ok(/孙智广/.test(root.textContent), '首页含作者「孙智广」署名');
ok(/软件化改造说明/.test(root.textContent), '首页含「软件化改造说明」区块');
ok(!!$('#view-root .authorcard') && $$('#view-root .authorcard__stats .stat').length >= 4,
  `软件化改造说明以作者卡呈现，附 ${$$('#view-root .authorcard__stats .stat').length} 项改造要点`);

/* ── 11.2b 原籍介绍（可展开全文） ──────────────────────── */
/* 原籍介绍原先只有一句摘要。现从《前言》补入「从哪来、怎么落脚」的完整三段，
   默认显示长摘要，点击展开全文。 */
section('原籍介绍');
const originBox = $('#view-root #hero-origin');
const originBtn = $('#view-root .hero__expand');
ok(!!originBtn, '英雄区提供「展开原籍全文」按钮');
ok(originBox?.hidden === true, '原籍全文默认收起');
ok(/文登县/.test(root.textContent) && /孙家洼/.test(root.textContent),
  '默认摘要已含原籍地望（山东登州府文登县孙家洼）');
/* 曾经的「内容过短」根因：摘要走 excerpt()，遇第一个句号即收尾，
   只剩「我孙氏（汉族）原籍山东省登州府文登县孙家洼（小地名南桥子白果树屯）。」一句。
   现按句累加，故断言摘要长度与「迁居经过」关键词。 */
const leadText = $('#view-root .hero__lead')?.textContent || '';
ok(/南桥子/.test(leadText) && /白果树/.test(leadText), '默认摘要保留小地名「南桥子白果树屯」');
ok(/康熙元年/.test(leadText), '默认摘要不止第一句，已含迁居经过');
ok(leadText.length >= 90, `默认摘要 ${leadText.length} 字（原先仅一句约 34 字）`);
originBtn?.dispatchEvent(new window.Event('click', { bubbles: true }));
await tick();
ok(originBox?.hidden === false, '点击后展开原籍全文');
ok(originBtn?.getAttribute('aria-expanded') === 'true', '按钮同步 aria-expanded');
const originText = originBox?.textContent || '';
for (const mark of ['南桥子', '白果树', '康熙元年', '徐文友', '三道嘴子', '曲姓女', '海北始祖']) {
  ok(originText.includes(mark), `原籍全文含「${mark}」`);
}
ok((originBox?.querySelectorAll('.doc-body p').length || 0) >= 3,
  `原籍全文为 ${originBox?.querySelectorAll('.doc-body p').length} 段原文（期望 ≥3）`);
originBtn?.dispatchEvent(new window.Event('click', { bubbles: true }));
await tick();
ok(originBox?.hidden === true, '再次点击可收起');

/* ── 11.2c 使用说明 ────────────────────────────────────── */
section('使用说明');
const guideBtn = $$('#view-root .entry-actions button').find((b) => b.textContent.includes('使用说明'));
ok(!!guideBtn, '「从这里开始」之后提供「使用说明」按钮');
guideBtn?.dispatchEvent(new window.Event('click', { bubbles: true }));
await tick();
const guideModal = document.querySelector('.modal-overlay');
ok(!!guideModal, '点击「使用说明」弹出说明对话框');
const guideText = guideModal?.textContent || '';
for (const mark of ['概览', '谱系图', '名录', '文献', '校验中心', '权限与数据']) {
  ok(guideText.includes(mark), `使用说明覆盖「${mark}」模块`);
}
ok(/快捷键/.test(guideText), '使用说明含快捷键一节');
ok((guideModal?.querySelectorAll('.guide__item').length || 0) >= 6,
  `使用说明分 ${guideModal?.querySelectorAll('.guide__item').length} 节`);
[...document.querySelectorAll('.modal-overlay .modal__footer button')]
  .find((b) => b.textContent.trim() === '知道了')?.click();
await tick();
ok(!document.querySelector('.modal-overlay'), '说明对话框可关闭');

/* ── 11.2d 访客权限显示收敛 ────────────────────────────── */
/* 访客只保留必要模块；「校验中心」「权限与数据」等治理类模块
   收进「其他权限」折叠组，而不是从界面上抹掉。 */
section('访客权限显示');
ok(!!$('#view-root .entry-others'), '访客角色下出现「其他权限」分组');
ok($('#view-root .entry-others__body')?.hidden === true, '「其他权限」默认收起');
ok($$('#view-root .entry-others .entry').length === 2,
  `「其他权限」内含 ${$$('#view-root .entry-others .entry').length} 个模块（期望 2）`);
const othersToggle = $('#view-root .entry-others__toggle');
othersToggle?.dispatchEvent(new window.Event('click', { bubbles: true }));
await tick();
ok($('#view-root .entry-others__body')?.hidden === false, '点击后展开「其他权限」');
ok(/校验中心/.test($('#view-root .entry-others')?.textContent || '')
  && /权限与数据/.test($('#view-root .entry-others')?.textContent || ''),
  '「校验中心」「权限与数据」均归入该分组');
othersToggle?.dispatchEvent(new window.Event('click', { bubbles: true }));
await tick();
ok($('#view-root .entry-others__body')?.hidden === true, '再次点击收起');

// 非访客：模块平铺，不做折叠（对其而言都是本职功能）
Auth.unlockSession();
roleSel.value = 'admin';
roleSel.dispatchEvent(new window.Event('change'));
await tick();
ok(!$('#view-root .entry-others'), '非访客角色下不出现「其他权限」折叠组');
ok($$('#view-root .entry').length === 6, `非访客平铺 ${$$('#view-root .entry').length} 张入口卡`);
Auth.lockSession();
roleSel.value = 'guest';
roleSel.dispatchEvent(new window.Event('change'));
await tick();
ok(!!$('#view-root .entry-others'), '切回访客后重新折叠');

/* ── 11.3 移动端底部导航 ───────────────────────────────── */
section('移动端底部导航');
ok(!!$('#tabbar'), '存在底部导航容器 #tabbar');
const tabItems = $$('#tabbar .tabbar__item');
ok(tabItems.length === 6, `底部导航 ${tabItems.length} 项（期望 6）`);
ok($$('#tabbar .tabbar__icon svg').length === 6, '底部导航每项均带图标');
app.go('docs');
ok($$('#tabbar .tabbar__item.is-active').length === 1, '底部导航同步高亮当前视图');
ok($('#tabbar .tabbar__item.is-active')?.dataset.key === 'docs', '高亮项与当前视图一致（docs）');
tabItems.find((b) => b.dataset.key === 'chart')?.dispatchEvent(new window.Event('click', { bubbles: true }));
await tick();
ok(currentViewKey() === 'chart', '点击底部导航可切换视图', `→ 当前 ${currentViewKey()}`);

/* ── 11.4 跨视图带参联动（首页 → 名录） ────────────────── */
section('跨视图带参联动');
app.go('explore', { q: '士仁' });
await tick();
const qItems = $$('#view-root .pitem').length;
ok(qItems > 0 && qItems < app.store.persons.length,
  `带检索词跳转名录：命中 ${qItems} / 全谱 ${app.store.persons.length} 人`);
ok(/士仁/.test(root.textContent), '名录视图已按传入关键词检索');
app.go('explore', { branchId: 'BR-LI' });
await tick();
const bItems = $$('#view-root .pitem').length;
ok(bItems > 0 && bItems < app.store.persons.length,
  `带支系跳转名录：礼支 ${bItems} / 全谱 ${app.store.persons.length} 人`);

/* ── 11.5 谱牒文献版式还原 ─────────────────────────────── */
section('谱牒文献版式');
app.go('docs');
ok($$('#view-root .fanziblock').length > 0, `凡字/位置按原表对齐还原 ${$$('#view-root .fanziblock').length} 块`);
ok($$('#view-root .toc-list .toc-list__item').length > 0 || $$('#view-root .toc-list li').length > 0,
  '文献目录按「序号 + 标题」配对重建');
ok(!/^\s*序号\s*$/m.test($('#view-root .toc-list')?.textContent || '  序号  '),
  '目录不再出现孤立的「序号」表头行');
ok(/孙智广/.test(root.textContent), '文献页同样附作者软件化改造说明');

/* ── 11.6 各页「快速跳转」条 ───────────────────────────── */
/* 谱系图 / 名录 / 校验中心都是数千像素的长页，读到末尾时顶栏早已滚出视野。
   故每个视图末尾固定一条跳转条：列出除当前页外的全部视图（5 项，含用途），
   并附「回到顶部」。此处逐个视图验证，避免只在首页接了跳转条就算完成。 */
section('页面快速跳转');
const JUMP_LABEL = { home: '概览', chart: '谱系图', explore: '名录', docs: '文献', validate: '校验', admin: '权限' };
for (const key of VIEW_KEYS) {
  app.go(key);
  await tick();
  const bar = $('#view-root .pagejump');
  ok(!!bar, `「${JUMP_LABEL[key]}」页底部有快速跳转条`);
  if (!bar) continue;
  const items = $$('#view-root .pagejump__item');
  ok(items.length === VIEW_KEYS.length - 1,
    `跳转项 ${items.length} 个（除当前页外共 ${VIEW_KEYS.length - 1} 个）`);
  const jumpKeys = items.map((b) => b.dataset.key);
  ok(!jumpKeys.includes(key), `跳转条不列当前页自身（${key}）`);
  ok(VIEW_KEYS.every((k) => k === key || jumpKeys.includes(k)), '其余视图均可达');
  ok(items.every((b) => (b.querySelector('.pagejump__icon svg')?.innerHTML || '').length > 20),
    '每个跳转项均带图标');
  ok(items.every((b) => /[\u4e00-\u9fa5]/.test(b.querySelector('.pagejump__name')?.textContent || '')),
    '每个跳转项均带中文名称');
  ok(!!$('#view-root .pagejump__top'), '跳转条含「回到顶部」');
}

// 实际点击可跨页跳转（跳转条必须真的能导航，而非只是摆设）
app.go('home');
await tick();
$$('#view-root .pagejump__item').find((b) => b.dataset.key === 'chart')
  ?.dispatchEvent(new window.Event('click', { bubbles: true }));
await tick();
ok(currentViewKey() === 'chart', '点击跳转项可切换视图', `→ 当前 ${currentViewKey()}`);

// 校验中心 →「名录·只看推导待核」：带参跳转须落到已筛选的列表
app.go('validate');
await tick();
const toInferred = $$('#view-root .pagejump__item').find((b) => b.dataset.key === 'explore');
ok(!!toInferred && /推导/.test(toInferred.textContent), '校验页提供「名录·只看推导待核」直达项');
toInferred?.dispatchEvent(new window.Event('click', { bubbles: true }));
await tick();
ok(currentViewKey() === 'explore', '带参跳转落到名录');
const inferredChip = $$('#view-root .chip').find((c) => /仅看推导待核/.test(c.textContent));
ok(inferredChip?.classList.contains('is-on') === true, '落地后「仅看推导待核」筛选已生效');
const inferredCount = $$('#view-root .pitem').length;
ok(inferredCount > 0 && inferredCount < app.store.persons.length,
  `推导待核命中 ${inferredCount} / 全谱 ${app.store.persons.length} 人`);

/* ── 12. 管理视图数据工具 ──────────────────────────────── */
section('管理视图');
app.go('admin');
ok(!!$('#view-root input[type="file"]') || /导出|导入/.test(root.textContent), '提供导入/导出入口');
ok(/审计|修订/.test(root.textContent), '提供审计日志区域');
ok($$('#view-root table tr').length > 4, `权限矩阵表 ${$$('#view-root table tr').length} 行`);

/* ── 汇总 ──────────────────────────────────────────────── */
console.log(`\n${'='.repeat(52)}`);
console.log(`渲染自检结果：通过 ${pass} 项，失败 ${fail} 项`);
console.log('='.repeat(52));
process.exit(fail ? 1 : 0);
