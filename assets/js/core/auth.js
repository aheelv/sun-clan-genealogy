/**
 * auth.js — 角色与访问控制（RBAC）
 * ---------------------------------------------------------------
 * 三层模型：
 *   角色 Role  →  权限 Permission  →  资源动作 resource:action
 *
 * 角色
 *   guest    访客   只读浏览，可查看校验报告，不可导出
 *   editor   编修   可新增/修改人物与关系、可导出；不可删除、不可导入覆盖、不可重置
 *   elder    族老   编修 + 删除 + 导入/导出 + 查阅审计日志
 *   admin    管理员 全部权限，含数据重置与角色管理
 *
 * 敏感字段级控制：schema.js 中每个字段标注 access 键，表单据此禁用输入。
 * 注意：这是"前端静态站点"的轻量治理模型，用于多人协作时的操作约束与留痕；
 *      它不提供密码学意义上的安全（数据在浏览器本地），真正的服务端部署应
 *      将同一权限矩阵搬到 API 层复用。
 *
 * 口令闸门：切到「非访客」角色须输入 ACCESS_PASSWORD（访客免）。它同样只是前端
 * 软门槛，边界见 ACCESS_PASSWORD 处的说明。切换的唯一入口是 ui/roleGate.js。
 */

export const ROLES = {
  guest: { key: 'guest', label: '访客', order: 0, desc: '只读浏览，可查阅校验报告' },
  editor: { key: 'editor', label: '编修', order: 1, desc: '新增／修改人物与关系，可导出数据' },
  elder: { key: 'elder', label: '族老', order: 2, desc: '编修权限 + 删除 + 导入 + 审计日志' },
  admin: { key: 'admin', label: '管理员', order: 3, desc: '全部权限，含数据重置与角色管理' },
};

/** 权限键：资源:动作 */
export const PERM = {
  PERSON_READ: 'person:read',
  PERSON_CREATE: 'person:create',
  PERSON_UPDATE: 'person:update',
  PERSON_DELETE: 'person:delete',
  PERSON_STRUCTURE: 'person:structure',   // 世代 / 支系等结构性字段
  RELATION_WRITE: 'relation:write',
  RELATION_DELETE: 'relation:delete',
  DATA_EXPORT: 'data:export',
  DATA_IMPORT: 'data:import',
  DATA_RESET: 'data:reset',
  AUDIT_READ: 'audit:read',
  ROLE_MANAGE: 'role:manage',
  VALIDATE_RUN: 'validate:run',
};

/** 权限矩阵 */
const MATRIX = {
  guest: [PERM.PERSON_READ, PERM.VALIDATE_RUN],
  editor: [
    PERM.PERSON_READ, PERM.PERSON_CREATE, PERM.PERSON_UPDATE,
    PERM.RELATION_WRITE, PERM.DATA_EXPORT, PERM.VALIDATE_RUN,
  ],
  elder: [
    PERM.PERSON_READ, PERM.PERSON_CREATE, PERM.PERSON_UPDATE, PERM.PERSON_DELETE,
    PERM.PERSON_STRUCTURE, PERM.RELATION_WRITE, PERM.RELATION_DELETE,
    PERM.DATA_EXPORT, PERM.DATA_IMPORT, PERM.AUDIT_READ, PERM.VALIDATE_RUN,
  ],
  admin: Object.values(PERM),
};

/* ── 口令闸门 ───────────────────────────────────────────── */

/**
 * 进入「非访客」角色所需的通行口令。
 *
 * ⚠ 这是**前端软门槛，不是安全措施**。静态站点会把全部代码下发给浏览器，
 *   任何人「查看网页源代码」都能读到本常量，也可在控制台直接执行
 *   `auth.setRole('admin')` 绕过。它只用于：挡住随手点击造成的误操作、
 *   以及无意的好奇浏览。真正的访问控制必须放在服务端 API 层。
 *
 * 要更换口令，改这一处即可（全站唯一来源）。
 */
export const ACCESS_PASSWORD = '888888';

/** 该角色是否需要口令才能进入（访客免） */
export function needsPassword(role) {
  return Object.prototype.hasOwnProperty.call(ROLES, role) && role !== 'guest';
}

/** 校验口令；空值/非字符串一律判否 */
export function verifyPassword(input) {
  return typeof input === 'string' && input.length > 0 && input === ACCESS_PASSWORD;
}

/** 会话内「已通过口令」标记的存储键（sessionStorage：关掉标签页即失效） */
const SS_UNLOCK = 'sunclan.genealogy.unlocked.v1';

export class Auth {
  constructor(role = 'guest') {
    this.role = ROLES[role] ? role : 'guest';
    this.listeners = new Set();
  }

  get roleMeta() { return ROLES[this.role]; }

  can(perm) {
    return (MATRIX[this.role] || []).includes(perm);
  }

  /** 至少具备某一权限 */
  canAny(...perms) { return perms.some((p) => this.can(p)); }

  /* ── 会话级口令状态 ───────────────────────────────────── */

  /** 本会话（标签页）内是否已通过口令 */
  static isUnlocked() {
    try { return sessionStorage.getItem(SS_UNLOCK) === '1'; } catch { return false; }
  }
  static unlockSession() {
    try { sessionStorage.setItem(SS_UNLOCK, '1'); } catch { /* 忽略 */ }
  }
  static lockSession() {
    try { sessionStorage.removeItem(SS_UNLOCK); } catch { /* 忽略 */ }
  }

  /**
   * 启动时决定以何种角色进入。
   * 持久化的角色只当「上次选择」的提示，**不作为授权依据**——
   * 非访客角色必须在本会话内通过口令后才会被恢复，否则一律回落「访客」。
   * （否则任何人只要本地存过一次 admin，刷新页面即可绕过口令。）
   */
  static restoreRole(saved) {
    if (!saved || saved === 'guest') return 'guest';
    return Auth.isUnlocked() ? saved : 'guest';
  }

  /**
   * 设置角色。**这是低层原语，不做口令校验**——口令闸门位于 UI 入口
   * （ui/roleGate.js 的 requestRoleSwitch），所有界面必须经由它切换角色，
   * 不得直接调用本方法。
   */
  setRole(role) {
    if (!ROLES[role] || role === this.role) return;
    this.role = role;
    this.emit();
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { this.listeners.forEach((fn) => fn(this.role)); }

  /** 权限矩阵快照，用于"权限说明"面板展示 */
  static matrix() {
    return Object.keys(ROLES).map((r) => ({
      role: ROLES[r],
      perms: MATRIX[r],
      can: (p) => MATRIX[r].includes(p),
    }));
  }
}

/** 权限清单（用于文档与界面展示） */
export const PERM_LABELS = {
  [PERM.PERSON_READ]: '浏览人物',
  [PERM.PERSON_CREATE]: '新增人物',
  [PERM.PERSON_UPDATE]: '修改人物',
  [PERM.PERSON_DELETE]: '删除人物',
  [PERM.PERSON_STRUCTURE]: '修改世代／支系',
  [PERM.RELATION_WRITE]: '建立关系',
  [PERM.RELATION_DELETE]: '解除关系',
  [PERM.DATA_EXPORT]: '导出数据',
  [PERM.DATA_IMPORT]: '导入数据',
  [PERM.DATA_RESET]: '重置数据',
  [PERM.AUDIT_READ]: '查阅审计日志',
  [PERM.ROLE_MANAGE]: '管理角色',
  [PERM.VALIDATE_RUN]: '运行校验',
};
