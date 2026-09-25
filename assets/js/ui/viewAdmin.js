/**
 * ui/viewAdmin.js — 权限与数据管理
 * 角色切换、权限矩阵、审计日志、数据导入导出与重置。
 */

import { h, toast, modal, download, confirmDialog } from '../core/dom.js';
import { PERM, PERM_LABELS, ROLES, Auth } from '../core/auth.js';
import { SCHEMA_VERSION, GEN_LABELS } from '../core/schema.js';
import { badge, card, emptyState, sectionHead, statCard, pageJump } from './components.js';
import { requestRoleSwitch } from './roleGate.js';

export function renderAdmin(store, { auth, seed, onRoleChange, onDataChanged, onNavigate }) {
  const root = h('div', { class: 'view' });

  /* ── 角色 ── */
  const roleCards = h('div', { class: 'grid grid--4' },
    ...Object.values(ROLES).map((r) => {
      const on = auth.role === r.key;
      return h('div', {
        class: 'card',
        style: { cursor: 'pointer', borderColor: on ? 'var(--accent)' : undefined, boxShadow: on ? 'var(--shadow-md)' : undefined },
        onClick: () => {
          requestRoleSwitch(auth, r.key, (role) => {
            auth.setRole(role);
            store.saveRole(role);
            onRoleChange(role);
            toast(`已切换为「${r.label}」`, 'ok');
            rerender();
          });
        },
      },
      h('div', { class: 'card__body' },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          h('h3', { class: 't-serif' }, r.label),
          h('div', { class: 'spacer', style: { flex: 1 } }),
          on ? badge('当前', 'gold') : null),
        h('p', { class: 't-sm t-dim', style: { margin: '6px 0 0' } }, r.desc),
        h('div', { class: 't-xs t-faint', style: { marginTop: '8px' } },
          `权限 ${Auth.matrix().find((m) => m.role.key === r.key).perms.length} / ${Object.keys(PERM).length} 项`)));
    }));

  /* ── 权限矩阵 ── */
  const matrix = Auth.matrix();
  const permKeys = Object.keys(PERM);
  const matrixTable = h('div', { class: 'table-wrap' },
    h('table', { class: 'perm-table' },
      h('thead', {}, h('tr', {},
        h('th', {}, '权限'),
        ...matrix.map((m) => h('th', {}, m.role.label)))),
      h('tbody', {}, ...permKeys.map((p) => h('tr', {},
        h('td', {}, PERM_LABELS[p] || p, h('div', { class: 'mono t-xs t-faint' }, p)),
        ...matrix.map((m) => h('td', { class: m.can(p) ? 'perm-yes' : 'perm-no' }, m.can(p) ? '✓' : '·')))))));

  /* ── 审计日志 ── */
  const auditHost = h('div', {});
  function renderAudit() {
    const canRead = auth.can(PERM.AUDIT_READ);
    if (!canRead) {
      auditHost.replaceChildren(card('审计日志', emptyState('权限不足', '查阅审计日志需要「族老」及以上角色', '锁')));
      return;
    }
    const logs = store.audit.slice(0, 120);
    auditHost.replaceChildren(card('审计日志', logs.length
      ? h('div', { class: 'timeline' }, ...logs.map((l) => h('div', { class: 'tl-item' },
        h('div', { class: 'tl-item__time' }, `${new Date(l.ts).toLocaleString('zh-CN', { hour12: false })}　·　修订 ${l.revision}　·　${l.actor}`),
        h('div', { class: 'tl-item__title' }, actionLabel(l.action)),
        h('div', { class: 'tl-item__body' }, l.detail))))
      : emptyState('暂无变更记录', '所有增删改操作都会在此留痕', '记'), {
      headExtra: h('span', { class: 'badge badge--muted' }, `共 ${store.audit.length} 条`),
    }));
  }

  /* ── 数据管理 ── */
  const dataHost = h('div', {});

  async function doExport() {
    if (!auth.can(PERM.DATA_EXPORT)) return toast('权限不足：导出需要「编修」及以上角色', 'error');
    const payload = store.exportPayload();
    download(`孙氏族谱-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(payload, null, 1));
    toast('已导出 JSON 归档', 'ok');
  }

  function doImport() {
    if (!auth.can(PERM.DATA_IMPORT)) return toast('权限不足：导入需要「族老」及以上角色', 'error');
    const input = h('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' } });
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const text = await file.text();
      let payload;
      try { payload = JSON.parse(text); } catch { return toast('文件不是合法 JSON', 'error'); }
      const ok = await confirmDialog('导入数据', `即将以「${file.name}」${payload.persons?.length || 0} 条人物记录替换当前数据，操作不可撤销。是否继续？`, { danger: true, okLabel: '确认导入' });
      if (!ok) return;
      const res = store.importPayload(payload, auth.role, 'replace');
      toast(res.message, res.ok ? 'ok' : 'error', 3600);
      if (res.ok) { rerender(); onDataChanged(); }
    };
    document.body.appendChild(input);
    input.click();
    setTimeout(() => input.remove(), 1000);
  }

  async function doReset() {
    if (!auth.can(PERM.DATA_RESET)) return toast('权限不足：重置需要「管理员」角色', 'error');
    const ok = await confirmDialog('重置为原始数据', '将丢弃全部本地修改，恢复到《孙氏族谱》原始转录状态。此操作不可撤销。', { danger: true, okLabel: '确认重置' });
    if (!ok) return;
    store.reset(auth.role);
    toast('已恢复原始转录数据', 'ok');
    rerender();
    onDataChanged();
  }

  function renderData() {
    const s = store.persons.length;
    dataHost.replaceChildren(
      h('div', { class: 'grid grid--4' },
        statCard({ label: '当前人物', value: s, unit: '条', hint: `修订号 ${store.revision}` }),
        statCard({ label: '数据来源', value: store.origin === 'seed' ? '原始转录' : '本地修改', hint: store.origin === 'seed' ? '尚未产生本地修改' : '已从种子数据派生' }),
        statCard({ label: '本地存储', value: (JSON.stringify(store.persons).length / 1024).toFixed(0), unit: 'KB', hint: 'localStorage' }),
        statCard({ label: '数据模式', value: SCHEMA_VERSION, hint: 'schemaVersion' })),
      h('div', { class: 'btn-row', style: { marginTop: '16px' } },
        h('button', { class: `btn${auth.can(PERM.DATA_EXPORT) ? '' : ' is-disabled'}`, onClick: doExport }, '导出 JSON 归档'),
        h('button', { class: `btn${auth.can(PERM.DATA_IMPORT) ? '' : ' is-disabled'}`, onClick: doImport }, '导入 JSON'),
        h('button', { class: `btn btn--danger${auth.can(PERM.DATA_RESET) ? '' : ' is-disabled'}`, onClick: doReset }, '重置为原始数据')),
      h('p', { class: 't-sm t-dim', style: { marginTop: '12px' } },
        '导出文件包含 persons、adoptions 与 schemaVersion，可用于跨设备迁移、版本归档或提交到服务端；'
        + '导入采用「覆盖」策略，同 schemaVersion 主版本号方可导入。'));
  }

  /* ── 关于 ── */
  const about = card('技术说明', [
    h('dl', { class: 'kv' },
      h('dt', {}, '架构'), h('dd', {}, '纯静态站点，原生 ES Module，零运行时依赖；双击 index.html 即可离线运行'),
      h('dt', {}, '分层'), h('dd', {}, 'core（schema / validate / store / auth / dom）→ domain（person / relation / branch）→ ui（views）'),
      h('dt', {}, '持久化'), h('dd', {}, 'localStorage，含 schemaVersion 与修订号；导出 JSON 作为长期归档'),
      h('dt', {}, '数据流'), h('dd', {}, 'xlsx/doc → extract_*.py → build_data.py → genealogy.json → emit_seed.py → seed.js → Store'),
      h('dt', {}, '可扩展'), h('dd', {}, '新增字段改 schema.js 即可全站生效；新增校验规则改 validate.js 注册表；'
        + '若接后端，只需替换 Store 的持久化实现，视图层无需改动'),
      h('dt', {}, '口令闸门'), h('dd', {}, '切到非访客角色需口令（访客免）。口令为前端常量（core/auth.js 的 '
        + 'ACCESS_PASSWORD），随代码下发、可在控制台绕过，**仅防误操作与好奇浏览，不是访问控制**；'
        + '真正的权限校验须放到服务端 API 层')),
    h('div', { style: { marginTop: '12px' } },
      h('div', { class: 'field__label', style: { marginBottom: '6px' } }, '源文件指纹（SHA-256）'),
      h('div', { class: 'refs' }, ...(seed.meta.sourceManifest || []).map((x) => h('span', { class: 'ref-cell', title: x.sha256 },
        `${x.file.split(/[\\/]/).pop()} · ${(x.sha256 || '').slice(0, 12)}…`)))),
  ]);

  function rerender() {
    roleCards.replaceWith(buildRoleCards());
    renderAudit();
    renderData();
  }

  function buildRoleCards() {
    return h('div', { class: 'grid grid--4' },
      ...Object.values(ROLES).map((r) => {
        const on = auth.role === r.key;
        return h('div', {
          class: 'card',
          style: { cursor: 'pointer', borderColor: on ? 'var(--accent)' : undefined },
          onClick: () => {
            requestRoleSwitch(auth, r.key, (role) => {
              auth.setRole(role);
              store.saveRole(role);
              onRoleChange(role);
              rerender();
              toast(`已切换为「${r.label}」`, 'ok');
            });
          },
        }, h('div', { class: 'card__body' },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
            h('h3', { class: 't-serif' }, r.label),
            h('div', { class: 'spacer', style: { flex: 1 } }),
            on ? badge('当前', 'gold') : null),
          h('p', { class: 't-sm t-dim', style: { margin: '6px 0 0' } }, r.desc)));
      }));
  }

  root.append(
    h('section', { class: 'hero', style: { paddingBottom: '24px' } },
      h('div', { class: 'moon', style: { opacity: '0.3' } }),
      h('div', { class: 'hero__inner' },
        h('div', { class: 'hero__eyebrow' }, 'Governance'),
        h('h1', { style: { fontSize: '2rem' } }, '权限与数据管理'),
        h('p', { class: 'hero__lead' },
          '本谱采用四角色 RBAC 模型：访客只读、编修可增改、族老可删改并导入、管理员拥有全部权限。'
          + '所有写操作均写入审计日志。'))),
    sectionHead('角色切换', h('span', { class: 't-sm t-faint' },
      '「访客」免口令；切换到其他角色需输入口令，通过后本会话内有效，刷新页面即重新上锁')),
    roleCards,
    sectionHead('权限矩阵'),
    card(null, matrixTable),
    sectionHead('数据管理'),
    dataHost,
    sectionHead('变更审计'),
    auditHost,
    sectionHead('技术说明'),
    about,
    pageJump({
      current: 'admin', onNavigate,
      note: '导出 JSON 归档后可跨设备迁移或提交服务端',
    }),
  );

  renderAudit();
  renderData();
  return root;
}

function actionLabel(a) {
  return { create: '新增人物', update: '修改人物', delete: '删除人物', import: '导入数据', reset: '重置数据' }[a] || a;
}
