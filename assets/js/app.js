/**
 * app.js — 应用装配与路由
 * ---------------------------------------------------------------
 * 依赖方向（严格单向）：
 *   ui/*  →  domain/*  →  core/*        （core 不反向依赖 domain / ui）
 * app.js 是唯一的装配点：注入 store / auth / 导航回调给各视图。
 */

import SEED from './data/seed.js';
import { h, $, clear, toast, confirmDialog } from './core/dom.js';
import { createStore } from './core/store.js';
import { Auth, ROLES, PERM } from './core/auth.js';
import { GEN_LABELS } from './core/schema.js';
import { displayName } from './domain/person.js';
import { renderPersonDetail } from './ui/personDetail.js';
import { openPersonForm } from './ui/personForm.js';
import { renderHome } from './ui/viewHome.js';
import { createChartView } from './ui/viewChart.js';
import { createExploreView } from './ui/viewExplore.js';
import { renderDocs } from './ui/viewDocs.js';
import { renderValidate } from './ui/viewValidate.js';
import { renderAdmin } from './ui/viewAdmin.js';
import { requestRoleSwitch } from './ui/roleGate.js';
import { VIEW_META, VIEW_ICONS } from './ui/viewMeta.js';

const store = createStore(SEED);
/* 持久化的角色仅作「上次选择」的提示，不作为授权依据：
 * 非访客角色必须在本会话内通过口令后才会被恢复，否则一律回落「访客」。 */
const auth = new Auth(Auth.restoreRole(store.loadRole()));

/* ── 视图注册表 ─────────────────────────────────────────── */
/* 「概览」置于首位并作为默认落点：进入站点先给出全谱概貌与导航；
 * 「谱系图」紧随其后，需要图形化全谱树时一键可达（快捷键 g）。
 *
 * 次序 / 名称 / 图标一律取自 ui/viewMeta.js 的 VIEW_META（唯一来源），
 * 顶部导航、底部标签栏与各页「快速跳转」条共用同一份，避免三处各写一套。
 * 这里只补各视图的 render 闭包——它需要 store / auth，只能在装配点构造。 */
const RENDERERS = {
  home: () => renderHome(store, { seed: SEED, auth, onPick: pick, onNavigate: go }),
  chart: () => createChartView(store, { auth, onPick: pick, onEdit, onDelete, onAddChild, onAddSpouse, renderDetail, onNavigate: go }),
  explore: () => createExploreView(store, { auth, onPick: pick, onEdit, onDelete, onAddChild, onAddSpouse, renderDetail, onNavigate: go }),
  docs: () => renderDocs(SEED, { onNavigate: go }),
  validate: () => renderValidate(store, { auth, onPick: pick, seed: SEED, onNavigate: go }),
  admin: () => renderAdmin(store, { auth, seed: SEED, onRoleChange: syncRoleUI, onDataChanged: () => refreshCurrent(), onNavigate: go }),
};

const VIEWS = VIEW_META.map((m) => ({ ...m, render: RENDERERS[m.key] }));

/* 底部标签栏图标与顶部导航共用同一份（VIEW_ICONS） */
const TAB_ICONS = VIEW_ICONS;

const cache = new Map();
let currentKey = 'home';

const main = $('#view-root');
const nav = $('#nav');
const tabbar = $('#tabbar');
const roleSelect = $('#role-select');
const revLabel = $('#rev-label');

/* ── 导航 ───────────────────────────────────────────────── */
function go(key, params) {
  if (!VIEWS.some((v) => v.key === key)) key = 'home';
  currentKey = key;
  location.hash = key;
  for (const btn of nav.children) btn.classList.toggle('is-active', btn.dataset.key === key);
  for (const btn of tabbar?.children || []) btn.classList.toggle('is-active', btn.dataset.key === key);

  let node = cache.get(key);
  if (!node) {
    node = VIEWS.find((v) => v.key === key).render();
    cache.set(key, node);
  }
  clear(main);
  main.appendChild(node);

  // 跨视图带参定位（首页检索 → 名录预填关键词；支系卡 → 名录按支系筛选；
  // 校验中心 → 名录只看推导待核）。必须在节点入 DOM 之后调用，
  // 否则视图内部的测量与刷新拿不到布局。
  if (params && typeof params === 'object') {
    if (params.q && node.__setQuery) node.__setQuery(params.q);
    if (params.branchId && node.__setBranch) node.__setBranch(params.branchId);
    if (params.inferred && node.__setInferred) node.__setInferred();
  }

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function refreshCurrent() {
  refreshDataViews();
  const key = currentKey;
  cache.delete(key);
  go(key);
}

/**
 * 数据变更后的统一刷新：失效派生视图缓存，并**就地**刷新图形与名录视图。
 * 刻意不跳转视图——编辑时打断浏览位置是可用性上的退步。
 */
function refreshDataViews() {
  cache.delete('home');
  cache.delete('validate');
  for (const k of ['chart', 'explore']) cache.get(k)?.__refreshAll?.();
}

/* ── 人物选择 / 编辑 ────────────────────────────────────── */
/**
 * 选中人物并定位。
 * 默认落在「谱系图」（本站主视图）；传 { view: 'explore' } 则在名录中定位。
 */
function pick(id, opts = {}) {
  const target = opts.view === 'explore' ? 'explore' : 'chart';
  if (currentKey !== target) go(target);
  cache.get(target)?.__select?.(id);
}

function renderDetail(person, opts = {}) {
  return renderPersonDetail(store, person, {
    auth, onPick: pick, onEdit, onDelete, onAddChild, onAddSpouse, focusId: opts.focusId,
  });
}

async function onEdit(person) {
  const res = await openPersonForm({ store, auth, person });
  if (!res.ok) return;
  refreshDataViews();
  pick(res.id || person.id);
  toast('已保存修改', 'ok');
}

async function onAddChild(parent) {
  const res = await openPersonForm({
    store, auth,
    person: null,
    presets: { fatherId: parent.id, gen: Math.min(18, parent.gen + 1), branchId: parent.branchId },
  });
  if (!res.ok) return;
  refreshDataViews();
  pick(res.id || parent.id);
  toast(`已为「${displayName(parent)}」添子`, 'ok');
}

async function onAddSpouse(owner) {
  const res = await openPersonForm({
    store, auth,
    person: null,
    presets: { spouseOfId: owner.id, gen: owner.gen, branchId: owner.branchId, isSpouse: true, gender: 'F' },
  });
  if (!res.ok) return;
  refreshDataViews();
  pick(res.id || owner.id);
  toast(`已为「${displayName(owner)}」添配`, 'ok');
}

async function onDelete(person) {
  const kids = store.childrenOf(person.id);
  const spouses = (person.spouseIds || []).map((id) => store.byId(id)).filter(Boolean);
  const impact = [
    kids.length ? `${kids.length} 名子女将解除父系挂接（成为世系断点）` : null,
    spouses.length ? `${spouses.length} 名配偶将解除婚姻关联` : null,
  ].filter(Boolean);
  const ok = await confirmDialog(
    `删除「${displayName(person)}」`,
    `该人物为${GEN_LABELS[person.gen]}，原谱出处 ${(person.refs || []).length} 处。`
    + (impact.length ? `\n\n影响面：${impact.join('；')}。` : '\n\n无子女与配偶关联。')
    + '\n\n此操作不可撤销（可在「权限」中重置或导入备份恢复）。',
    { danger: true, okLabel: '确认删除' },
  );
  if (!ok) return;
  store.deletePerson(person.id, auth.role);
  toast('已删除', 'ok');
  refreshDataViews();
  go(currentKey);
}

/* ── 顶栏 / 底部标签栏 ─────────────────────────────────── */
/**
 * 两处导航共用同一份 VIEWS，只是形态不同：
 *   顶部 —— 大屏横向文字导航
 *   底部 —— 小屏图标标签栏（拇指可达；由 CSS 在 ≤760px 时显示）
 * 二者在 go() 中同步高亮，不各写一套状态。
 */
function buildNav() {
  clear(nav);
  for (const v of VIEWS) {
    nav.appendChild(h('button', {
      class: `nav-item${v.key === currentKey ? ' is-active' : ''}`,
      dataset: { key: v.key },
      onClick: () => go(v.key),
    }, v.label));
  }
}

function buildTabbar() {
  if (!tabbar) return;
  clear(tabbar);
  for (const v of VIEWS) {
    tabbar.appendChild(h('button', {
      class: `tabbar__item${v.key === currentKey ? ' is-active' : ''}`,
      dataset: { key: v.key },
      title: v.label,
      'aria-label': v.label,
      onClick: () => go(v.key),
    },
    h('span', { class: 'tabbar__icon', html: `<svg viewBox="0 0 32 32" aria-hidden="true">${TAB_ICONS[v.key] || ''}</svg>` }),
    h('span', { class: 'tabbar__label' }, v.label)));
  }
}

function syncRoleUI(role) {
  if (roleSelect) roleSelect.value = role;
  const hint = $('#role-hint');
  if (hint) hint.textContent = ROLES[role]?.label || role;
  // 权限变化后重建所有做权限判定的视图（home 的模块入口也随角色收敛）
  for (const k of ['home', 'chart', 'explore', 'admin', 'validate']) cache.delete(k);
  go(currentKey);
}

function buildRoleSelect() {
  if (!roleSelect) return;
  clear(roleSelect);
  for (const r of Object.values(ROLES)) roleSelect.appendChild(h('option', { value: r.key }, r.label));
  roleSelect.value = auth.role;
  roleSelect.onchange = () => {
    const target = roleSelect.value;
    // 先复位显示：口令未通过时下拉框不应停在未授权的角色上
    roleSelect.value = auth.role;
    requestRoleSwitch(auth, target, (role) => {
      auth.setRole(role);
      store.saveRole(role);
      toast(`已切换为「${ROLES[role].label}」`, 'ok');
      syncRoleUI(role);
    });
  };
}

function buildThemeToggle() {
  const btn = $('#theme-toggle');
  const apply = (t) => {
    document.documentElement.dataset.theme = t;
    btn.textContent = t === 'dark' ? '桂影夜宴' : '宣纸月华';
    try { localStorage.setItem('sunclan.theme', t); } catch { /* 忽略 */ }
  };
  let saved = 'light';
  try { saved = localStorage.getItem('sunclan.theme') || 'light'; } catch { /* 忽略 */ }
  apply(saved);
  btn.onclick = () => apply(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
}

/* ── 启动 ───────────────────────────────────────────────── */
function boot() {
  buildNav();
  buildTabbar();
  buildRoleSelect();
  buildThemeToggle();

  const updateRev = () => {
    if (revLabel) {
      revLabel.textContent = `修订 ${store.revision}　·　${store.persons.length} 人`;
      revLabel.title = store.origin === 'seed' ? '当前为原始转录数据，尚无本地修改' : '包含本地修改';
    }
  };
  updateRev();
  store.subscribe(() => updateRev());

  const hash = (location.hash || '').replace('#', '');
  go(VIEWS.some((v) => v.key === hash) ? hash : 'home');

  window.addEventListener('hashchange', () => {
    const k = (location.hash || '').replace('#', '');
    if (k && k !== currentKey && VIEWS.some((v) => v.key === k)) go(k);
  });

  // 全局快捷键：/ 聚焦检索；g 回到谱系图
  document.addEventListener('keydown', (e) => {
    const typing = /input|textarea|select/i.test(document.activeElement?.tagName || '');
    if (e.key === '/' && !typing) {
      e.preventDefault();
      go('explore');
      setTimeout(() => cache.get('explore')?.querySelector('input.input--search')?.focus(), 60);
    } else if (e.key === 'g' && !typing && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      go('chart');
    }
  });

  console.info('[孙氏族谱] 已加载', {
    人物: store.persons.length,
    过继关系: store.adoptions.length,
    修订: store.revision,
    角色: auth.role,
    数据来源: store.origin,
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

export { store, auth, go, pick };
