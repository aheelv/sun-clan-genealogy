/**
 * dom.js — 极简 DOM 工具（hyperscript 风格）
 * 不引入任何框架：本站在 file:// 下直接运行，依赖越少越稳。
 */

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class' || k === 'className') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value' && 'value' in el) el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * SVG 版 hyperscript。
 * 与 h() 的区别：使用 createElementNS 创建 SVG 命名空间元素，
 * 且 class / 属性一律走 setAttribute（SVG 元素没有 className/style 的 DOM 语义）。
 * 供谱系图形视图绘制节点与连线使用。
 */
export function s(tag, props = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'dataset') {
      for (const [dk, dv] of Object.entries(v)) el.setAttribute(`data-${dk}`, String(dv));
    } else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === 'text') {
      el.textContent = v;
    } else {
      el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

/** 供 SVG <text> 使用的安全文本（避免原文中的 & < > 破坏标记） */
export function escText(v) {
  return String(v ?? '');
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/** 简易防抖 */
export function debounce(fn, ms = 200) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/** 模态对话框（返回 Promise） */
export function modal({ title, body, actions = [], width = 560 }) {
  return new Promise((resolve) => {
    const overlay = h('div', { class: 'modal-overlay' });
    const close = (v) => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKey);

    const footer = h('div', { class: 'modal__footer' },
      ...actions.map((a) => h('button', {
        class: `btn ${a.variant || 'btn--ghost'}`,
        onClick: () => close(a.value === undefined ? a.key : a.value),
      }, a.label)));

    overlay.appendChild(h('div', { class: 'modal', style: { maxWidth: width + 'px' }, onClick: (e) => e.stopPropagation() },
      h('header', { class: 'modal__head' },
        h('h3', {}, title),
        h('button', { class: 'modal__close', onClick: () => close(null), 'aria-label': '关闭' }, '×')),
      h('div', { class: 'modal__body' }, body),
      footer));
    overlay.addEventListener('click', () => close(null));
    document.body.appendChild(overlay);
    const first = overlay.querySelector('input,select,textarea,button');
    if (first) setTimeout(() => first.focus(), 30);
  });
}

/** 轻提示 */
export function toast(message, kind = 'info', ms = 2600) {
  let host = document.getElementById('toast-host');
  if (!host) { host = h('div', { id: 'toast-host', class: 'toast-host' }); document.body.appendChild(host); }
  const t = h('div', { class: `toast toast--${kind}` }, message);
  host.appendChild(t);
  setTimeout(() => { t.classList.add('is-out'); setTimeout(() => t.remove(), 300); }, ms);
}

export function confirmDialog(title, message, { danger = false, okLabel = '确定' } = {}) {
  return modal({
    title,
    body: h('p', { class: 'modal__text' }, message),
    actions: [
      { label: '取消', value: false, variant: 'btn--ghost' },
      { label: okLabel, value: true, variant: danger ? 'btn--danger' : 'btn--primary' },
    ],
  });
}

export function download(filename, text) {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
