/**
 * render_test.mjs — 端到端渲染自检（jsdom）
 * ---------------------------------------------------------------
 * 在真实 DOM 实现中加载 index.html，导入 app.js，验证：
 *   · 启动无异常，导航与视图根节点完成渲染
 *   · 六个视图（概览/谱系图/名录/文献/校验/权限）均可切换并产出内容；默认落点为「概览」
 *   · 谱系图：SVG 图形真实产出（世代带、连线、节点、过继弧线）、
 *             节点点击联动档案栏、深度/方向/模式切换、过继信息可读
 *   · 检索、关注人物、角色切换、主题切换等关键交互生效
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
try {
  app = await import(pathToFileURL(join(ROOT, 'assets', 'js', 'app.js')).href);
  ok(true, 'app.js 导入并执行 boot() 无异常');
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

/* ── 6. 名录检索交互 ───────────────────────────────────── */
section('名录检索交互');
app.go('explore');
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
ok($$('#view-root .entry__icon svg').length >= 6, '入口卡均带图标');
ok(/孙智广/.test(root.textContent), '首页含作者「孙智广」署名');
ok(/软件化改造说明/.test(root.textContent), '首页含「软件化改造说明」区块');
ok(!!$('#view-root .authorcard') && $$('#view-root .authorcard__stats .stat').length >= 4,
  `软件化改造说明以作者卡呈现，附 ${$$('#view-root .authorcard__stats .stat').length} 项改造要点`);

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
