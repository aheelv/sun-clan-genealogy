/**
 * ui/components.js — 可复用展示组件
 */

import { h, esc } from '../core/dom.js';
import { GEN_LABELS, CONFIDENCE, EVIDENCE, NOTE_TYPE, PERSON_STATUS } from '../core/schema.js';
import { branchMeta } from '../domain/branch.js';
import { displayName } from '../domain/person.js';
import { VIEW_META, VIEW_ICONS } from './viewMeta.js';

export const badge = (text, tone = 'muted', title) =>
  h('span', { class: `badge badge--${tone}`, title: title || undefined }, text);

export const genBadge = (gen) => badge(GEN_LABELS[gen] || `${gen}世`, 'muted');

export const branchBadge = (branchId) => {
  const b = branchMeta(branchId);
  return badge(b.short, b.tone === 'muted' ? 'muted' : b.tone, b.name);
};

export const confidenceBadge = (conf) => {
  const c = CONFIDENCE[conf] || CONFIDENCE.unknown;
  return badge(c.label, c.tone);
};

export const evidenceBadge = (ev) => {
  const e = EVIDENCE[ev] || { label: ev || '—', tone: 'muted' };
  return badge(e.label, e.tone);
};

export const statusBadge = (status) => {
  const s = PERSON_STATUS[status] || PERSON_STATUS.normal;
  return s.key === 'normal' ? null : badge(s.label, 'muted');
};

export const flagsBadges = (flags) =>
  h('span', { class: 'chip-set' }, ...flags.map((f) => badge(f.label, f.tone)));

export const avatar = (person) =>
  h('span', { class: `pitem__avatar${person.isSpouse ? ' is-spouse' : ''}` },
    person.isSpouse ? (person.surname || '氏') : person.name.slice(-1));

export function statCard({ label, value, unit, hint }) {
  return h('div', { class: 'stat' },
    h('div', { class: 'stat__label' }, label),
    h('div', { class: 'stat__value' }, String(value), unit ? h('small', {}, unit) : null),
    hint ? h('div', { class: 'stat__hint' }, hint) : null);
}

export function sectionHead(title, extra) {
  return h('div', { class: 'section-head' }, h('h2', {}, title), h('div', { class: 'rule' }), extra || null);
}

export function emptyState(title, hint, mark = '空') {
  return h('div', { class: 'empty' },
    h('div', { class: 'empty__mark' }, mark),
    h('div', { class: 'empty__title' }, title),
    hint ? h('div', { class: 't-sm t-faint', style: { marginTop: '6px' } }, hint) : null);
}

export function card(title, bodyChildren, { headExtra, foot } = {}) {
  return h('section', { class: 'card' },
    title ? h('header', { class: 'card__head' }, h('h3', {}, title), h('div', { class: 'spacer' }), headExtra || null) : null,
    h('div', { class: 'card__body' }, bodyChildren),
    foot ? h('footer', { class: 'card__foot' }, foot) : null);
}

/** 可点击的人物胶囊 */
export function personPill(person, onPick, { prefix } = {}) {
  return h('button', {
    class: `rel-pill${person.isSpouse ? ' is-spouse' : ''}`,
    onClick: (e) => { e.stopPropagation(); onPick(person.id); },
  }, prefix ? h('span', { class: 't-faint' }, prefix) : null, displayName(person));
}

/** 世系路径面包屑 */
export function pathLine(chain, onPick) {
  return h('div', { class: 'pathline' },
    ...chain.flatMap((p, i) => [
      i ? h('span', { class: 'sep' }, '›') : null,
      h('button', { onClick: () => onPick(p.id) }, `${displayName(p)}(${GEN_LABELS[p.gen]})`),
    ]).filter(Boolean));
}

/** 出处标签 */
export function refChips(refs, max = 8) {
  const shown = refs.slice(0, max);
  return h('div', { class: 'refs' },
    ...shown.map((r) => h('span', {
      class: 'ref-cell',
      title: `第${r[0]}页 ${String.fromCharCode(64 + r[2])}${r[1]} 原值：${r[3]}`,
    }, `第${r[0]}页·${String.fromCharCode(64 + r[2])}${r[1]}`)),
    refs.length > max ? h('span', { class: 'ref-cell' }, `+${refs.length - max}`) : null);
}

/** 凡字表 */
export function genCharTable(gens) {
  const half = Math.ceil(gens.length / 2);
  const row = (list) => h('tr', {},
    ...list.map((g) => h('td', { class: g.char ? 'is-char' : 'is-empty' }, g.char || '—')));
  const head = (list) => h('tr', {}, ...list.map((g) => h('th', {}, g.gen)));
  return h('table', { class: 'genchar-table' },
    h('tbody', {},
      head(gens.slice(0, half)), row(gens.slice(0, half)),
      head(gens.slice(half)), row(gens.slice(half))));
}

/** 简易进度条 */
export const bar = (pct) => h('div', { class: 'bar' }, h('div', { class: 'bar__fill', style: { width: `${Math.min(100, pct)}%` } }));

export function severityPill(level) {
  const map = { error: ['error', '错误'], warn: ['warn', '警告'], info: ['info', '提示'] };
  const [tone, label] = map[level] || ['muted', level];
  return badge(label, tone);
}

/* ══ 页面级快捷跳转 ═══════════════════════════════════════ */

/** 单个跳转按钮：图标 + 名称 + 一句用途，避免只给图标让人猜 */
function jumpItem({ key, label, icon, hint, params }, onNavigate) {
  return h('button', {
    class: 'pagejump__item',
    dataset: { key },
    title: hint ? `${label} — ${hint}` : label,
    onClick: () => onNavigate(key, params),
  },
  h('span', { class: 'pagejump__icon', html: `<svg viewBox="0 0 32 32" aria-hidden="true">${VIEW_ICONS[icon] || ''}</svg>` }),
  h('span', { class: 'pagejump__text' },
    h('span', { class: 'pagejump__name' }, label),
    hint ? h('span', { class: 'pagejump__hint' }, hint) : null));
}

/**
 * 页面底部的「快速跳转」条。
 *
 * 为什么需要它：顶栏导航在长页面上够不着——谱系图、名录、校验中心都可能是
 * 数千像素的滚动页，读到末尾想换页只能先滚回顶部。故在每个视图底部固定给一条
 * 跳转条，列出**除当前页外**的全部视图（含用途说明），并附「回到顶部」。
 *
 * @param {string} current    当前视图键（自身不再列出）
 * @param {Function} onNavigate  app.js 的 go(key, params)
 * @param {Array}  extra      对某个视图的**上下文改写**：{ key, hint?, params? }
 * @param {string} note       右侧补充说明
 *
 * `extra` 的语义是「改写」而非「追加」：若按追加处理，同一视图会在条上出现两次
 * （校验页既有「名录」又有「名录·只看推导待核」）。故按 key 合并覆盖，并保持
 * VIEW_META 的次序。名称与图标一律取自 VIEW_META，不随上下文改——
 * 跳转条的可用性全在「一眼认出目标页」，与顶栏同名同图才认得出来；
 * 上下文的差别只体现在用途说明（hint）与跳转参数（params）上。
 */
export function pageJump({ current, onNavigate, extra = [], note } = {}) {
  const override = new Map(extra.filter((x) => x && x.key).map((x) => [x.key, x]));
  const items = VIEW_META
    .filter((v) => v.key !== current)
    .map((v) => {
      const o = override.get(v.key);
      return o ? { ...v, hint: o.hint ?? v.hint, params: o.params } : v;
    });
  return h('nav', { class: 'pagejump', 'aria-label': '快速跳转到其他页面' },
    h('div', { class: 'pagejump__head' },
      h('span', { class: 'pagejump__label' }, '快速跳转'),
      note ? h('span', { class: 't-xs t-faint' }, note) : null,
      h('div', { class: 'spacer' }),
      h('button', {
        class: 'btn btn--sm pagejump__top',
        onClick: () => window.scrollTo({ top: 0, behavior: 'smooth' }),
      }, '回到顶部 ↑')),
    h('div', { class: 'pagejump__items' },
      ...items.map((v) => jumpItem(v, onNavigate))));
}

export { displayName, GEN_LABELS, NOTE_TYPE, esc, VIEW_META, VIEW_ICONS };
