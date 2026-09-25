/**
 * ui/roleGate.js — 角色切换的口令闸门
 * ---------------------------------------------------------------
 * **全站唯一的角色切换入口。** 顶部角色下拉（app.js）与权限页角色卡
 * （ui/viewAdmin.js）都必须经由 requestRoleSwitch，不得直接调用 auth.setRole。
 *
 * 放行规则
 *   切到「访客」        → 直接放行，并清除本会话的解锁标记（回到访客即视为退出）
 *   已在非访客角色       → 直接放行（本会话已通过口令，避免来回切换反复弹窗）
 *   访客 → 非访客        → 弹出对话框，口令正确才放行
 *
 * 安全边界：这是前端软门槛。口令常量随代码下发，可在控制台绕过。
 *          它只防误操作与好奇浏览，不构成访问控制。
 */

import { h, toast } from '../core/dom.js';
import { Auth, needsPassword, verifyPassword } from '../core/auth.js';

/**
 * 请求切换到目标角色。
 * @param {Auth} auth          认证实例
 * @param {string} target      目标角色键
 * @param {(role:string)=>void} onGranted  口令通过（或无需口令）后执行真正的切换
 */
export function requestRoleSwitch(auth, target, onGranted) {
  if (!needsPassword(target)) {
    // 回到访客：视为退出，重新上锁
    Auth.lockSession();
    onGranted(target);
    return;
  }
  if (auth.role !== 'guest' || Auth.isUnlocked()) {
    // 本会话已通过口令，不再重复索要
    onGranted(target);
    return;
  }
  askPassword(target, onGranted);
}

/** 口令对话框。复用 modal 系列样式，但不走 core/dom.js 的 modal()——
 *  因为需要「校验失败时不关闭」的语义，而 modal() 的按钮点击即关闭。 */
function askPassword(target, onGranted) {
  const input = h('input', {
    class: 'input',
    type: 'password',
    placeholder: '请输入口令',
    autocomplete: 'current-password',
    'aria-label': '角色口令',
  });
  const err = h('p', { class: 'field__error', style: { minHeight: '1.2em', margin: '6px 0 0' } });
  /* .field.is-invalid 是既有的错误态样式（见 components.css），须由外层 .field 承载 */
  const field = h('div', { class: 'field' }, input);

  let settled = false;
  const close = () => {
    if (settled) return;
    settled = true;
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') cancel(); };
  const cancel = () => {
    if (settled) return;
    close();
    toast('已取消切换，仍为「访客」', 'info');
  };

  const submit = () => {
    if (settled) return;
    if (verifyPassword(input.value)) {
      Auth.unlockSession();
      close();
      onGranted(target);
    } else {
      err.textContent = '口令不正确，请重试';
      field.classList.add('is-invalid');
      input.value = '';
      input.focus();
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
  });
  input.addEventListener('input', () => { err.textContent = ''; field.classList.remove('is-invalid'); });

  const overlay = h('div', { class: 'modal-overlay' });
  overlay.appendChild(h('div', {
    class: 'modal',
    style: { maxWidth: '420px' },
    onClick: (e) => e.stopPropagation(),
  },
  h('header', { class: 'modal__head' },
    h('h3', {}, '需要口令'),
    h('button', { class: 'modal__close', onClick: cancel, 'aria-label': '关闭' }, '×')),
  h('div', { class: 'modal__body' },
    h('p', { class: 'modal__text', style: { marginTop: 0 } },
      '以「访客」浏览无需口令；切换到其他角色需要口令。'),
    field, err),
  h('div', { class: 'modal__footer' },
    h('button', { class: 'btn btn--ghost', onClick: cancel }, '取消'),
    h('button', { class: 'btn btn--primary', onClick: submit }, '确定'))));

  overlay.addEventListener('click', cancel);
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  setTimeout(() => input.focus(), 30);
}
