/**
 * ui/viewExplore.js — 世系浏览（列表视图 / 世系树视图）
 */

import { h, debounce } from '../core/dom.js';
import { GEN_LABELS, PERSON_STATUS } from '../core/schema.js';
import { searchPersons, filterPersons, sortPersons, displayName, personFlags } from '../domain/person.js';
import { BRANCHES, branchMeta } from '../domain/branch.js';
import { indexById, indexChildren, pathToRoot, ancestorsOf } from '../domain/relation.js';
import { badge, branchBadge, genBadge, emptyState, avatar, flagsBadges, personPill } from './components.js';

const PAGE_SIZE = 60;

export function createExploreView(store, { auth, onPick, onEdit, onDelete, onAddChild, onAddSpouse, renderDetail }) {
  const state = {
    mode: 'list',
    query: '',
    gens: new Set(),
    branchIds: new Set(),
    statuses: new Set(),
    onlyInferred: false,
    sortKey: 'gen',
    page: 1,
    selectedId: null,
    expanded: new Set(),
  };

  const root = h('div', { class: 'view' });
  const listHost = h('div', {});
  const detailHost = h('div', {});
  const treeHost = h('div', {});

  /* ── 工具栏 ── */
  const searchInput = h('input', {
    class: 'input input--search', placeholder: '检索姓名、注音、旁注或原谱单元格…',
    oninput: debounce((e) => { state.query = e.target.value; state.page = 1; refreshList(); }, 180),
  });

  const chipSet = (label, items, set, onToggle, labelFn = (x) => x.label) => {
    const wrap = h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } },
      h('span', { class: 't-xs t-faint' }, label));
    const chips = items.map((it) => {
      const on = set.has(it.key);
      const chip = h('button', {
        class: `chip${on ? ' is-on' : ''}`,
        onClick: () => {
          if (set.has(it.key)) set.delete(it.key); else set.add(it.key);
          chip.classList.toggle('is-on');
          state.page = 1;
          onToggle();
        },
      }, labelFn(it), it.count != null ? h('span', { class: 'chip__count' }, it.count) : null);
      return chip;
    });
    wrap.append(...chips);
    return wrap;
  };

  const genCounts = new Map();
  for (const p of store.persons) genCounts.set(p.gen, (genCounts.get(p.gen) || 0) + 1);
  const branchCounts = new Map();
  for (const p of store.persons) branchCounts.set(p.branchId, (branchCounts.get(p.branchId) || 0) + 1);

  const segListBtn = h('button', { class: 'is-on', onClick: (e) => switchMode('list', e.target) }, '列表');
  const segTreeBtn = h('button', { onClick: (e) => switchMode('tree', e.target) }, '世系树');
  const segButtons = [segListBtn, segTreeBtn];

  const toolbar = h('div', { class: 'toolbar' },
    h('div', { class: 'search-wrap', style: { flex: '1 1 260px' } }, searchInput),
    h('div', { class: 'seg' }, segListBtn, segTreeBtn),
    h('div', { class: 'spacer' }),
    h('span', { class: 't-xs t-faint', id: 'explore-count' }, ''));

  const filterBar = h('div', { class: 'card', style: { marginBottom: '12px' } },
    h('div', { class: 'card__body', style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
      chipSet('世代', Array.from({ length: 18 }, (_, i) => ({
        key: i + 1, label: GEN_LABELS[i + 1], count: genCounts.get(i + 1) || 0,
      })).filter((x) => x.count), state.gens, () => refreshList()),
      chipSet('支系', BRANCHES.filter((b) => branchCounts.get(b.id)).map((b) => ({
        key: b.id, label: b.short, count: branchCounts.get(b.id) || 0,
      })), state.branchIds, () => refreshList()),
      h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } },
        h('span', { class: 't-xs t-faint' }, '筛选'),
        (() => {
          const c = h('button', {
            class: 'chip',
            onClick: () => { state.onlyInferred = !state.onlyInferred; c.classList.toggle('is-on'); state.page = 1; refreshList(); },
          }, '仅看推导待核');
          return c;
        })(),
        (() => {
          const c = h('button', {
            class: 'chip',
            onClick: () => { state.branchIds.clear(); state.gens.clear(); state.onlyInferred = false; state.page = 1; refresh(); },
          }, '清空筛选');
          return c;
        })(),
        h('div', { class: 'spacer' }),
        h('span', { class: 't-xs t-faint' }, '排序'),
        (() => {
          const sel = h('select', { class: 'select', style: { width: 'auto' } });
          [['gen', '世代'], ['name', '姓名'], ['children', '子女数'], ['spouses', '配偶数']]
            .forEach(([v, l]) => sel.appendChild(h('option', { value: v }, l)));
          sel.onchange = () => { state.sortKey = sel.value; refreshList(); };
          return sel;
        })())));

  /* ── 列表视图 ── */
  function currentList() {
    let list = store.persons;
    list = searchPersons(list, state.query);
    list = filterPersons(list, {
      gens: [...state.gens],
      branchIds: [...state.branchIds],
      onlyInferred: state.onlyInferred,
    });
    return sortPersons(list, state.sortKey, 'asc');
  }

  function refreshList() {
    const list = currentList();
    const totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    state.page = Math.min(state.page, totalPages);
    const pageItems = list.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);
    const counter = root.querySelector('#explore-count');
    if (counter) counter.textContent = `命中 ${list.length} / 共 ${store.persons.length} 人`;

    listHost.replaceChildren(h('div', { class: 'card' },
      h('div', { class: 'card__body card__body--tight' },
        pageItems.length ? h('div', { class: 'plist' },
          ...pageItems.map((p) => {
            const kids = store.childrenOf(p.id).length;
            const flags = personFlags(p, { childCount: kids });
            return h('div', {
              class: `pitem${state.selectedId === p.id ? ' is-selected' : ''}`,
              onClick: () => select(p.id),
            },
            avatar(p),
            h('div', { class: 'pitem__main' },
              h('div', { class: 'pitem__name' }, displayName(p),
                p.unnamed ? h('span', { class: 'badge badge--muted', style: { marginLeft: '6px' } }, '未具名') : null),
              h('div', { class: 'pitem__sub' },
                h('span', {}, GEN_LABELS[p.gen]),
                h('span', {}, branchMeta(p.branchId).short + '支'),
                kids ? h('span', {}, `${kids} 子`) : null,
                (p.spouseIds || []).length ? h('span', {}, `${p.spouseIds.length} 配`) : null,
                (p.refs || []).length ? h('span', {}, `出处 ${p.refs.length}`) : null)),
            flags.length ? flagsBadges(flags.slice(0, 2)) : null);
          })) : emptyState('无匹配人物', '调整检索词或清空筛选条件', '寻')),
      totalPages > 1 ? h('div', { class: 'pager' },
        h('button', { class: 'btn btn--sm', disabled: state.page === 1, onClick: () => { state.page--; refreshList(); } }, '上一页'),
        `第 ${state.page} / ${totalPages} 页`,
        h('button', { class: 'btn btn--sm', disabled: state.page === totalPages, onClick: () => { state.page++; refreshList(); } }, '下一页')) : null));
  }

  /* ── 世系树视图 ── */
  const byId = () => indexById(store.persons);
  const childMap = () => indexChildren(store.persons);

  function treeNode(person, cm, depth) {
    const kids = cm.get(person.id) || [];
    const hasKids = kids.length > 0;
    const isOpen = state.expanded.has(person.id);
    const li = h('li', {});

    const toggle = h('button', {
      class: `tnode__toggle${hasKids ? '' : ' is-leaf'}`,
      onClick: (e) => {
        e.stopPropagation();
        if (state.expanded.has(person.id)) state.expanded.delete(person.id);
        else state.expanded.add(person.id);
        renderTree();
      },
    }, isOpen ? '−' : '+');

    const node = h('span', {
      class: `tnode${state.selectedId === person.id ? ' is-selected' : ''}${person.isSpouse ? ' is-spouse' : ''}`,
      onClick: () => select(person.id),
      title: `${GEN_LABELS[person.gen]} · ${(person.refs || []).map((r) => `第${r[0]}页`).slice(0, 4).join(' ')}`,
    },
    toggle,
    h('span', { class: 'tnode__name' }, displayName(person)),
    h('span', { class: 'tnode__meta' }, `${GEN_LABELS[person.gen]}`),
    (person.spouseIds || []).length ? h('span', { class: 'tnode__meta' }, `配${person.spouseIds.length}`) : null,
    person.parentEvidence === 'heuristic' ? badge('推导', 'clay') : null);

    li.appendChild(node);
    if (hasKids && isOpen) {
      const ul = h('ul', {});
      for (const k of kids) ul.appendChild(treeNode(k, cm, depth + 1));
      // 配偶以斜体虚线跟随
      for (const sid of person.spouseIds || []) {
        const sp = byId().get(sid);
        if (!sp) continue;
        ul.appendChild(h('li', {},
          h('span', {
            class: `tnode is-spouse${state.selectedId === sp.id ? ' is-selected' : ''}`,
            onClick: () => select(sp.id),
          }, h('span', { class: 'tnode__toggle is-leaf' }, ''), h('span', { class: 'tnode__name' }, sp.name),
          h('span', { class: 'tnode__meta' }, '配'))));
      }
      li.appendChild(ul);
    }
    return li;
  }

  function renderTree() {
    const cm = childMap();
    const roots = store.persons.filter((p) => !p.isSpouse && (!p.fatherId || !byId().has(p.fatherId)));
    const ordered = roots.sort((a, b) => a.gen - b.gen || a.id.localeCompare(b.id));
    const ul = h('ul', {});
    for (const r of ordered) ul.appendChild(treeNode(r, cm, 0));
    treeHost.replaceChildren(h('div', { class: 'card' },
      h('header', { class: 'card__head' },
        h('h3', {}, '世系树'),
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn btn--sm', onClick: () => { state.expanded = new Set(store.persons.filter((p) => p.gen <= 3).map((p) => p.id)); renderTree(); } }, '展开至三世'),
        h('button', { class: 'btn btn--sm', onClick: () => { state.expanded = new Set(); renderTree(); } }, '全部折叠')),
      h('div', { class: 'card__body' },
        h('p', { class: 't-sm t-dim' },
          '默认折叠，点击节点右侧 +/− 展开后代；虚线框为配偶。父子关系标注「推导」者来自规则推导，需人工复核。'),
        h('div', { class: 'tree', style: { maxHeight: '68vh', overflow: 'auto' } }, ul))));
  }

  /* ── 选择与模式切换 ── */
  function select(id) {
    state.selectedId = id;
    const p = store.persons.find((x) => x.id === id);
    if (!p) return;
    detailHost.replaceChildren(renderDetail(p, { focusId: null }));

    if (state.mode === 'list') {
      // 从其他视图（概览主脉 / 校验中心 / 检索结果）跳转过来时，目标可能不在当前页，
      // 此处自动翻到其所在页，避免「详情已切换但列表无高亮」的断裂感。
      const idx = currentList().findIndex((x) => x.id === id);
      if (idx >= 0) state.page = Math.floor(idx / PAGE_SIZE) + 1;
      refreshList();
      listHost.querySelector('.pitem.is-selected')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else {
      // 树模式：展开目标及其全部祖先，确保节点可见
      for (const a of ancestorsOf(id, byId())) state.expanded.add(a.id);
      state.expanded.add(id);
      renderTree();
    }

    const aside = root.querySelector('.split__aside');
    if (aside && window.innerWidth < 1080) aside.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function switchMode(mode, btn) {
    state.mode = mode;
    const seg = btn.parentElement;
    Array.from(seg.children).forEach((b) => b.classList.toggle('is-on', b === btn));
    listHost.hidden = mode !== 'list';
    treeHost.hidden = mode !== 'tree';
  }

  function refresh() {
    filterBar.replaceWith(buildFilterBar());
    refreshList();
    if (state.mode === 'tree') renderTree();
  }

  function buildFilterBar() {
    // 重建筛选条（清空筛选时同步 chip 状态）
    const node = filterBar.cloneNode(false);
    const body = h('div', { class: 'card__body', style: { display: 'flex', flexDirection: 'column', gap: '8px' } });
    body.appendChild(chipSet('世代', Array.from({ length: 18 }, (_, i) => ({
      key: i + 1, label: GEN_LABELS[i + 1], count: genCounts.get(i + 1) || 0,
    })).filter((x) => x.count), state.gens, () => refreshList()));
    body.appendChild(chipSet('支系', BRANCHES.filter((b) => branchCounts.get(b.id)).map((b) => ({
      key: b.id, label: b.short, count: branchCounts.get(b.id) || 0,
    })), state.branchIds, () => refreshList()));
    node.appendChild(body);
    return node;
  }

  root.append(toolbar, filterBar, h('div', { class: 'split' },
    h('div', {}, listHost, treeHost),
    h('div', { class: 'split__aside' }, detailHost)));

  // 初始：默认展开始祖与二世
  state.expanded = new Set(store.persons.filter((p) => p.gen <= 1).map((p) => p.id));
  refreshList();
  renderTree();
  treeHost.hidden = true;
  detailHost.replaceChildren(renderDetail(null, {}));

  root.__select = select;
  root.__refreshAll = () => { refreshList(); if (state.mode === 'tree') renderTree(); };

  /** 外部（首页检索、支系卡）预填检索词：同步输入框、复位分页并重建筛选条 */
  /**
   * 外部（首页快捷检索）预填关键词。
   * 视图节点被缓存复用，若不主动复位，上一次的支系/世代筛选会与本次关键词
   * 交叉过滤，用户点「查看全部 N 条结果」却只看到几个人。故显式复位其余筛选。
   */
  root.__setQuery = (q) => {
    state.query = String(q || '');
    state.page = 1;
    state.branchIds.clear();
    state.gens.clear();
    state.onlyInferred = false;
    searchInput.value = state.query;
    switchMode('list', segButtons[0]);
    filterBar.replaceWith(buildFilterBar());
    refreshList();
  };

  /** 外部（首页支系卡）按支系筛选，同理复位检索词 */
  root.__setBranch = (branchId) => {
    state.branchIds = new Set([branchId]);
    state.page = 1;
    state.query = '';
    searchInput.value = '';
    switchMode('list', segButtons[0]);
    filterBar.replaceWith(buildFilterBar());
    refreshList();
  };

  return root;
}
