/**
 * ui/personForm.js — 新增 / 编辑人物表单
 * 字段定义、必填与约束全部读取 core/schema.js；权限按字段 access 逐项禁用。
 */

import { h, modal, toast } from '../core/dom.js';
import { PERSON_FIELDS, FORM_FIELDS, GEN_LABELS, PERSON_STATUS, GENDER } from '../core/schema.js';
import { PERM } from '../core/auth.js';
import { validateField } from '../core/validate.js';
import { BRANCHES } from '../domain/branch.js';
import { displayName } from '../domain/person.js';

const BRANCH_OPTIONS = BRANCHES.filter((b) => b.id !== 'BR-UNDEF');

function personOptions(store, { exclude = [], filter = () => true } = {}) {
  const ex = new Set(exclude);
  return store.persons
    .filter((p) => !ex.has(p.id) && filter(p))
    .map((p) => ({ value: p.id, label: `${displayName(p)}（${GEN_LABELS[p.gen]}·${p.branchKey}）` }))
    .sort((a, b) => a.label.localeCompare(b.label, 'zh'));
}

/**
 * @param {object} opts
 * @param {import('../core/store.js').Store} opts.store
 * @param {object} opts.auth
 * @param {object|null} opts.person  null=新增
 * @param {object} opts.presets     新增时的预设值（如父、世代）
 * @returns {Promise<{ok:boolean, id?:string}>}
 */
export async function openPersonForm({ store, auth, person = null, presets = {} }) {
  const isEdit = !!person;
  const draft = isEdit
    ? { ...person }
    : {
      name: '', surname: '孙', givenName: '', gender: 'M', isSpouse: false,
      gen: presets.gen || 1, branchId: presets.branchId || 'BR-UNDEF', status: 'normal',
      pinyin: '', fatherId: presets.fatherId || null, spouseOfId: presets.spouseOfId || null,
    };

  const errors = new Map();
  const inputs = new Map();
  const body = h('div', {});

  const fieldNode = (key) => {
    const def = PERSON_FIELDS[key];
    const canWrite = auth.can(def.access);
    const wrap = h('div', { class: 'field' });
    const label = h('label', { class: 'field__label' },
      def.label, def.required ? h('span', { class: 'req' }, '·') : null,
      !canWrite ? h('span', { class: 'badge badge--muted' }, '权限受限') : null);
    wrap.appendChild(label);

    let input;
    const setVal = (v) => { draft[key] = v; };

    if (key === 'gender') {
      input = h('select', { class: 'select', disabled: !canWrite });
      for (const g of Object.values(GENDER)) input.appendChild(h('option', { value: g.key }, `${g.label}（${g.symbol}）`));
      input.value = draft.gender;
      input.onchange = () => setVal(input.value);
    } else if (key === 'isSpouse') {
      input = h('select', { class: 'select', disabled: !canWrite });
      input.appendChild(h('option', { value: 'false' }, '本族男丁'));
      input.appendChild(h('option', { value: 'true' }, '配偶（附于夫主）'));
      input.value = String(draft.isSpouse);
      input.onchange = () => setVal(input.value === 'true');
    } else if (key === 'gen') {
      input = h('select', { class: 'select', disabled: !canWrite });
      for (let g = 1; g <= 18; g++) input.appendChild(h('option', { value: g }, GEN_LABELS[g]));
      input.value = draft.gen;
      input.onchange = () => setVal(Number(input.value));
    } else if (key === 'branchId') {
      input = h('select', { class: 'select', disabled: !canWrite });
      for (const b of BRANCH_OPTIONS) input.appendChild(h('option', { value: b.id }, b.name));
      input.value = draft.branchId;
      input.onchange = () => setVal(input.value);
    } else if (key === 'status') {
      input = h('select', { class: 'select', disabled: !canWrite });
      for (const s of Object.values(PERSON_STATUS)) input.appendChild(h('option', { value: s.key }, s.label));
      input.value = draft.status;
      input.onchange = () => setVal(input.value);
    } else if (key === 'fatherId') {
      input = h('select', { class: 'select', disabled: !canWrite });
      input.appendChild(h('option', { value: '' }, '— 未挂接（世系断点）—'));
      const opts = personOptions(store, {
        exclude: isEdit ? [person.id, ...(person.childrenIds || [])] : [],
        filter: (p) => !p.isSpouse,
      });
      for (const o of opts) input.appendChild(h('option', { value: o.value }, o.label));
      input.value = draft.fatherId || '';
      input.onchange = () => setVal(input.value || null);
    } else if (key === 'spouseOfId') {
      input = h('select', { class: 'select', disabled: !canWrite });
      input.appendChild(h('option', { value: '' }, '— 无 —'));
      const opts = personOptions(store, { exclude: isEdit ? [person.id] : [], filter: (p) => !p.isSpouse });
      for (const o of opts) input.appendChild(h('option', { value: o.value }, o.label));
      input.value = draft.spouseOfId || '';
      input.onchange = () => setVal(input.value || null);
    } else {
      input = h('input', {
        class: 'input', disabled: !canWrite,
        placeholder: def.placeholder || '',
        maxlength: def.max || 32,
      });
      input.value = draft[key] ?? '';
      input.oninput = () => setVal(input.value.trim());
    }

    inputs.set(key, input);
    wrap.appendChild(input);

    if (def.hint) wrap.appendChild(h('div', { class: 'field__hint' }, def.hint));
    const errBox = h('div', { class: 'field__error', style: { display: 'none' } });
    wrap.appendChild(errBox);

    const run = () => {
      const list = validateField(key, draft[key]);
      const err = list.find((x) => x.level === 'error');
      const warn = list.find((x) => x.level === 'warn');
      if (err) {
        errors.set(key, err.message);
        errBox.textContent = err.message;
        errBox.style.display = '';
        wrap.classList.add('is-invalid');
      } else {
        errors.delete(key);
        if (warn) {
          errBox.textContent = warn.message;
          errBox.className = 'field__warn';
          errBox.style.display = '';
        } else {
          errBox.style.display = 'none';
        }
        wrap.classList.remove('is-invalid');
      }
    };
    input.addEventListener('change', run);
    input.addEventListener('input', run);
    return wrap;
  };

  // 表单按"身份 / 世系 / 归属"分组
  const groups = [
    ['身份', ['name', 'surname', 'givenName', 'pinyin', 'gender', 'isSpouse']],
    ['世系', ['gen', 'fatherId', 'spouseOfId']],
    ['归属', ['branchId', 'status']],
  ];
  for (const [title, keys] of groups) {
    body.appendChild(h('div', { class: 'field__label', style: { marginTop: '6px', marginBottom: '8px', color: 'var(--accent-strong)' } }, title));
    for (const k of keys) if (FORM_FIELDS.includes(k)) body.appendChild(fieldNode(k));
  }
  body.appendChild(h('div', { class: 't-xs t-faint' },
    '提示：世代与支系属结构性字段，需「族老」及以上角色方可修改；改动会写入审计日志。'));

  // 初次校验
  for (const k of FORM_FIELDS) {
    const el = inputs.get(k);
    if (el) el.dispatchEvent(new Event('change'));
  }

  const result = await modal({
    title: isEdit ? `编辑人物 · ${displayName(person)}` : '新增人物',
    body,
    width: 640,
    actions: [
      { label: '取消', value: '__cancel', variant: 'btn--ghost' },
      { label: isEdit ? '保存修改' : '创建', value: '__ok', variant: 'btn--primary' },
    ],
  });
  if (result !== '__ok') return { ok: false };

  // 强制重跑一遍校验
  for (const k of FORM_FIELDS) {
    const el = inputs.get(k);
    if (el) el.dispatchEvent(new Event('change'));
  }
  if (errors.size) {
    toast(`存在 ${errors.size} 项校验错误，请修正后重试`, 'error');
    return { ok: false };
  }

  const payload = {};
  for (const k of FORM_FIELDS) payload[k] = draft[k];

  const res = isEdit
    ? store.updatePerson(person.id, payload, auth.role)
    : store.createPerson(payload, auth.role);

  if (!res.ok) {
    toast(res.issues?.find((i) => i.level === 'error')?.message || '保存失败', 'error');
    return { ok: false };
  }
  const warns = (res.issues || []).filter((i) => i.level === 'warn');
  toast(isEdit ? '已保存修改' : '已新增人物', 'ok');
  if (warns.length) toast(`另有 ${warns.length} 条提示，见校验中心`, 'warn', 3600);
  return { ok: true, id: res.id || person.id };
}
