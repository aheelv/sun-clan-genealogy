/**
 * store.js — 数据仓库（Repository）
 * ---------------------------------------------------------------
 * 职责
 *   · 持有全谱状态（persons / adoptions / audit）
 *   · 持久化到 localStorage（含 schema 版本与修订号）
 *   · 提供唯一写入口 CRUD，所有写操作经校验 + 留痕（审计日志）
 *   · 提供派生查询上下文（ctx）供校验引擎与视图使用
 *
 * 单一事实来源（SSOT）
 *   persons 数组即 SSOT；父子关系由 person.fatherId 派生，婚姻由 person.spouseIds
 *   与 person.spouseOfId 派生，避免"关系表与人物表打架"。过继（adoption）为
 *   独立关系，因为它不改变父系归属，只增加一重社会关系。
 */

import { SCHEMA_VERSION, GEN_LABELS, GEN_CHAR_MAP } from './schema.js';
import { validateRecord } from './validate.js';

const LS_KEY = 'sunclan.genealogy.state.v1';
const LS_ROLE = 'sunclan.genealogy.role.v1';
const MAX_AUDIT = 500;

export class Store {
  constructor(seed) {
    this.seed = seed;
    this.listeners = new Set();
    this.state = this.#restore(seed);
  }

  /* ── 持久化 ───────────────────────────────────────────── */

  #restore(seed) {
    let persisted = null;
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) persisted = JSON.parse(raw);
    } catch { /* 忽略损坏的本地数据，回落种子 */ }

    if (persisted && persisted.schemaVersion === SCHEMA_VERSION && Array.isArray(persisted.persons)) {
      return {
        schemaVersion: persisted.schemaVersion,
        revision: persisted.revision ?? 1,
        origin: 'local',
        persons: persisted.persons,
        adoptions: persisted.adoptions || [],
        audit: persisted.audit || [],
        updatedAt: persisted.updatedAt || null,
      };
    }
    return {
      schemaVersion: SCHEMA_VERSION,
      revision: 1,
      origin: 'seed',
      persons: JSON.parse(JSON.stringify(seed.persons)),
      adoptions: JSON.parse(JSON.stringify(seed.adoptions || [])),
      audit: [],
      updatedAt: seed.meta?.generatedAt || null,
    };
  }

  #persist() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        schemaVersion: this.state.schemaVersion,
        revision: this.state.revision,
        persons: this.state.persons,
        adoptions: this.state.adoptions,
        audit: this.state.audit.slice(0, MAX_AUDIT),
        updatedAt: this.state.updatedAt,
      }));
    } catch (e) {
      console.warn('[store] 本地持久化失败（可能超出配额）', e);
    }
  }

  /* ── 订阅 ─────────────────────────────────────────────── */

  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  #notify(evt) { this.listeners.forEach((fn) => fn(evt)); }

  /* ── 只读查询 ─────────────────────────────────────────── */

  get persons() { return this.state.persons; }
  get adoptions() { return this.state.adoptions; }
  get audit() { return this.state.audit; }
  get revision() { return this.state.revision; }
  get origin() { return this.state.origin; }

  byId(id) { return this._index.get(id); }
  get(id) { return this._index.get(id); }

  /**
   * 重建索引（构造与每次写操作后调用）。
   *   _index    : id → person
   *   _children : fatherId → person[]（父子关系由 fatherId 派生，故须同步重建）
   */
  reindex() {
    const byId = new Map();
    const kids = new Map();
    for (const p of this.state.persons) {
      byId.set(p.id, p);
      if (p.fatherId) {
        const arr = kids.get(p.fatherId);
        if (arr) arr.push(p); else kids.set(p.fatherId, [p]);
      }
    }
    this._index = byId;
    this._children = kids;
    return byId;
  }

  childrenOf(id) {
    return this._children.get(id) || [];
  }

  /** 派生：父子 / 婚姻关系列表（供关系视图与导出使用） */
  relations() {
    const out = [];
    let n = 0;
    for (const p of this.state.persons) {
      if (p.fatherId && this._index.has(p.fatherId)) {
        out.push({
          id: `D${++n}`, type: 'parent-child', fromId: p.fatherId, toId: p.id,
          evidence: p.parentEvidence || 'manual',
          confidence: ['doc', 'spine', 'note'].includes(p.parentEvidence) ? 'explicit' : 'inferred',
          derived: true,
        });
      }
    }
    for (const p of this.state.persons) {
      if (p.isSpouse && p.spouseOfId && this._index.has(p.spouseOfId)) {
        out.push({
          id: `D${++n}`, type: 'spouse', fromId: p.spouseOfId, toId: p.id,
          evidence: 'adjacency', confidence: 'explicit', derived: true,
        });
      }
    }
    for (const a of this.state.adoptions) out.push({ ...a, derived: false });
    return out;
  }

  /** 祖先链（自下而上） */
  ancestorsOf(id, limit = 30) {
    const chain = [];
    let cur = this._index.get(id);
    while (cur && cur.fatherId && chain.length < limit) {
      const f = this._index.get(cur.fatherId);
      if (!f) break;
      chain.push(f);
      cur = f;
    }
    return chain;
  }

  /** 校验引擎所需的上下文 */
  ctx() {
    const store = this;
    return {
      persons: store.state.persons,
      get: (id) => store._index.get(id),
      childrenOf: (id) => store.childrenOf(id),
      isBranchHead: (p) => ['BR-REN', 'BR-LI', 'BR-YI', 'BR-ZHI', 'BR-BIN', 'BR-JI'].includes(p.branchId) && p.gen === 3,
      genLabel: (g) => GEN_LABELS[g] || `${g}世`,
      genChar: (g) => GEN_CHAR_MAP[g] || null,
    };
  }

  /* ── 写操作（唯一入口） ───────────────────────────────── */

  #audit(action, detail, actor) {
    this.state.audit.unshift({
      ts: new Date().toISOString(), action, detail, actor,
      revision: this.state.revision,
    });
    if (this.state.audit.length > MAX_AUDIT) this.state.audit.length = MAX_AUDIT;
  }

  #commit(evt) {
    this.state.revision += 1;
    this.state.updatedAt = new Date().toISOString();
    this.reindex();
    this.#persist();
    this.#notify(evt);
  }

  nextId(prefix = 'P') {
    const nums = this.state.persons
      .filter((p) => p.id.startsWith(prefix))
      .map((p) => parseInt(p.id.slice(prefix.length), 10))
      .filter((n) => !Number.isNaN(n));
    const max = nums.length ? Math.max(...nums) : 0;
    return `${prefix}${String(max + 1).padStart(4, '0')}`;
  }

  /**
   * 新增人物。
   * @returns {{ok:boolean, id?:string, issues?:Array}}
   */
  createPerson(input, actor = 'system') {
    const draft = {
      id: this.nextId(input.isSpouse ? 'S' : 'P'),
      name: '', surname: '孙', givenName: null, gender: 'M', isSpouse: false,
      unnamed: false, gen: 1, branchId: 'BR-UNDEF', status: 'normal',
      pinyin: null, namedSpouse: false, fatherId: null, spouseOfId: null,
      spouseIds: [], childrenIds: [], parentEvidence: 'manual',
      confidence: { parent: 'manual' }, notes: [], refs: [], ...input,
    };
    const issues = validateRecord(draft, this.ctx());
    if (issues.some((i) => i.level === 'error')) return { ok: false, issues };

    this.state.persons.push(draft);
    this.#linkSpouse(draft);
    this.#audit('create', `新增人物 ${draft.name}（${GEN_LABELS[draft.gen]}）`, actor);
    this.#commit({ type: 'create', id: draft.id });
    return { ok: true, id: draft.id, issues };
  }

  /** 修改人物（patch 只需传变更字段） */
  updatePerson(id, patch, actor = 'system') {
    const cur = this._index.get(id);
    if (!cur) return { ok: false, issues: [{ level: 'error', message: '人物不存在' }] };
    const before = { ...cur };
    const draft = { ...cur, ...patch };
    const issues = validateRecord(draft, this.ctx());
    if (issues.some((i) => i.level === 'error')) return { ok: false, issues };

    // 配偶归属变更时维护反向引用
    if (before.spouseOfId && before.spouseOfId !== draft.spouseOfId) {
      const old = this._index.get(before.spouseOfId);
      if (old) old.spouseIds = (old.spouseIds || []).filter((x) => x !== id);
    }
    Object.assign(cur, draft);
    this.#linkSpouse(cur);

    const changed = Object.keys(patch).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(cur[k]));
    this.#audit('update', `修改 ${cur.name}：${changed.join('、') || '无实质变更'}`, actor);
    this.#commit({ type: 'update', id });
    return { ok: true, issues };
  }

  #linkSpouse(p) {
    if (!p.spouseOfId) return;
    const owner = this._index.get(p.spouseOfId) || this.state.persons.find((x) => x.id === p.spouseOfId);
    if (owner) {
      owner.spouseIds = owner.spouseIds || [];
      if (!owner.spouseIds.includes(p.id)) owner.spouseIds.push(p.id);
    }
    p.isSpouse = true;
    p.gender = p.gender === 'U' ? 'F' : p.gender;
  }

  /**
   * 删除人物。级联策略：子女与配偶的引用被置空（不连带删除），
   * 删除前返回影响面供界面二次确认。
   */
  deletePerson(id, actor = 'system', { cascade = 'detach' } = {}) {
    const cur = this._index.get(id);
    if (!cur) return { ok: false, issues: [{ level: 'error', message: '人物不存在' }] };

    const kids = this.childrenOf(id);
    const spouses = (cur.spouseIds || []).map((s) => this._index.get(s)).filter(Boolean);
    if (cascade === 'detach') {
      for (const k of kids) { k.fatherId = null; k.parentEvidence = 'manual'; }
      for (const s of spouses) { s.spouseOfId = null; s.isSpouse = true; }
      if (cur.spouseOfId) {
        const owner = this._index.get(cur.spouseOfId);
        if (owner) owner.spouseIds = (owner.spouseIds || []).filter((x) => x !== id);
      }
    }
    this.state.persons = this.state.persons.filter((p) => p.id !== id);
    this.state.adoptions = this.state.adoptions.filter((a) => a.fromId !== id && a.toId !== id);
    this.#audit('delete', `删除 ${cur.name}（${GEN_LABELS[cur.gen]}）｜影响：子女 ${kids.length} 人、配偶 ${spouses.length} 人已解绑`, actor);
    this.#commit({ type: 'delete', id });
    return { ok: true, impact: { children: kids, spouses } };
  }

  /** 批量修改（用于树视图拖拽挂接等场景） */
  updateMany(patches, actor = 'system') {
    const results = [];
    for (const [id, patch] of patches) results.push([id, this.updatePerson(id, patch, actor)]);
    return results;
  }

  /** 重置为原始种子数据 */
  reset(actor = 'system') {
    this.state.persons = JSON.parse(JSON.stringify(this.seed.persons));
    this.state.adoptions = JSON.parse(JSON.stringify(this.seed.adoptions || []));
    this.#audit('reset', '恢复为《孙氏族谱》原始转录数据', actor);
    this.#commit({ type: 'reset' });
  }

  /* ── 导入 / 导出 ──────────────────────────────────────── */

  exportPayload() {
    return {
      format: 'sunclan-genealogy',
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      revision: this.state.revision,
      meta: this.seed.meta,
      persons: this.state.persons,
      adoptions: this.state.adoptions,
    };
  }

  /**
   * 导入。mode='replace' 覆盖，mode='merge' 按 id 合并（同 id 覆盖）。
   * @returns {{ok:boolean, message:string, issues:Array}}
   */
  importPayload(payload, actor = 'system', mode = 'replace') {
    if (!payload || !Array.isArray(payload.persons)) {
      return { ok: false, message: '文件格式不正确：缺少 persons 数组', issues: [] };
    }
    if (payload.schemaVersion && payload.schemaVersion.split('.')[0] !== SCHEMA_VERSION.split('.')[0]) {
      return { ok: false, message: `数据模式版本不兼容：文件 ${payload.schemaVersion}，当前 ${SCHEMA_VERSION}`, issues: [] };
    }
    if (mode === 'replace') {
      this.state.persons = JSON.parse(JSON.stringify(payload.persons));
      this.state.adoptions = JSON.parse(JSON.stringify(payload.adoptions || []));
    } else {
      const idx = new Map(this.state.persons.map((p, i) => [p.id, i]));
      for (const p of payload.persons) {
        if (idx.has(p.id)) this.state.persons[idx.get(p.id)] = p;
        else this.state.persons.push(p);
      }
    }
    this.#audit('import', `导入数据（${mode}）：${payload.persons.length} 条人物`, actor);
    this.#commit({ type: 'import' });
    return { ok: true, message: `已导入 ${payload.persons.length} 条人物记录（${mode === 'replace' ? '覆盖' : '合并'}）`, issues: [] };
  }

  /* ── 角色持久化 ───────────────────────────────────────── */

  loadRole() {
    try { return localStorage.getItem(LS_ROLE) || 'guest'; } catch { return 'guest'; }
  }
  saveRole(role) {
    try { localStorage.setItem(LS_ROLE, role); } catch { /* 忽略 */ }
  }
}

export function createStore(seed) {
  const s = new Store(seed);
  s.reindex();
  return s;
}
