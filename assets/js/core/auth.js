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
