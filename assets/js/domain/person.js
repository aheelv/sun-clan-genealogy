/**
 * domain/person.js — 人物领域服务
 * 检索、筛选、排序、统计与展示格式化（纯函数）。
 */

import { GEN_LABELS, GEN_CHAR_MAP, PERSON_STATUS, CONFIDENCE, EVIDENCE, NOTE_TYPE, GENDER } from '../core/schema.js';

/** 全文检索：姓名 / 注音 / 旁注 / 出处单元格 */
export function searchPersons(persons, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return persons;
  return persons.filter((p) => {
    const hay = [
      p.name, p.givenName, p.surname, p.pinyin,
      ...(p.notes || []).map((n) => n.text),
      ...(p.refs || []).map((r) => r[3]),
    ].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
  });
}

/** 多条件筛选 */
export function filterPersons(persons, { gens = [], branchIds = [], statuses = [], genders = [], onlySpouse = null, onlyInferred = false, onlyIssue = null } = {}) {
  return persons.filter((p) => {
    if (gens.length && !gens.includes(p.gen)) return false;
    if (branchIds.length && !branchIds.includes(p.branchId)) return false;
    if (statuses.length && !statuses.includes(p.status)) return false;
    if (genders.length && !genders.includes(p.gender)) return false;
    if (onlySpouse === true && !p.isSpouse) return false;
    if (onlySpouse === false && p.isSpouse) return false;
    if (onlyInferred && p.parentEvidence !== 'heuristic') return false;
    if (onlyIssue && !(p.notes || []).some((n) => n.type === onlyIssue)) return false;
    return true;
  });
}

export function sortPersons(list, key = 'gen', dir = 'asc') {
  const mul = dir === 'asc' ? 1 : -1;
  const get = {
    gen: (p) => p.gen * 100000 + parseInt(p.id.replace(/\D/g, ''), 10),
    name: (p) => p.name,
    branch: (p) => p.branchId + p.gen,
    children: (p) => -(p.childrenIds || []).length,
    spouses: (p) => -(p.spouseIds || []).length,
  }[key] || ((p) => p.id);
  return [...list].sort((a, b) => {
    const va = get(a), vb = get(b);
    if (va < vb) return -1 * mul;
    if (va > vb) return 1 * mul;
    return a.id.localeCompare(b.id);
  });
}

/** 全谱统计 */
export function computeStats(persons) {
  const males = persons.filter((p) => !p.isSpouse);
  const byGen = new Map();
  for (const p of persons) byGen.set(p.gen, (byGen.get(p.gen) || 0) + 1);
  const byBranch = new Map();
  for (const p of persons) byBranch.set(p.branchId, (byBranch.get(p.branchId) || 0) + 1);

  const withNotes = persons.filter((p) => (p.notes || []).length);
  const inferred = persons.filter((p) => p.parentEvidence === 'heuristic');
  const namedSpouses = persons.filter((p) => p.namedSpouse);
  const maxGen = Math.max(...persons.map((p) => p.gen), 1);
  const leaves = males.filter((p) => !(p.childrenIds || []).length);

  return {
    total: persons.length,
    males: males.length,
    spouses: persons.length - males.length,
    maxGen,
    branchCount: new Set(persons.map((p) => p.branchId)).size,
    byGen: [...byGen.entries()].sort((a, b) => a[0] - b[0]).map(([gen, n]) => ({ gen, label: GEN_LABELS[gen], count: n })),
    byBranch,
    withNotes: withNotes.length,
    inferred: inferred.length,
    namedSpouses: namedSpouses.length,
    leaves: leaves.length,
    avgChildren: males.length ? ((males.length - leaves.length) / males.length).toFixed(2) : '0',
  };
}

/** 人物展示名 */
export function displayName(p) {
  if (!p) return '—';
  if (p.isSpouse) return p.name;
  return p.name.startsWith('孙') ? p.name : '孙' + p.name;
}

export const genderLabel = (g) => GENDER[g]?.label ?? '—';
export const statusMeta = (s) => PERSON_STATUS[s] || PERSON_STATUS.normal;
export const confidenceMeta = (c) => CONFIDENCE[c] || CONFIDENCE.unknown;
export const evidenceMeta = (e) => EVIDENCE[e] || { key: e, label: e || '—', tone: 'muted' };
export const noteLabel = (t) => NOTE_TYPE[t] || t;
export const genChar = (g) => GEN_CHAR_MAP[g] || null;

/** 出处（原谱单元格）格式化 */
export function refLabel(ref) {
  const [page, row, col, raw] = ref;
  return { page, row, col, raw, cell: `${String.fromCharCode(64 + col)}${row}` };
}

/** 人物健康度：返回该人物的校验要点数（用于列表徽标） */
export function personFlags(p, { childCount = 0 } = {}) {
  const flags = [];
  if (p.parentEvidence === 'heuristic') flags.push({ tone: 'clay', label: '推导待核' });
  if (p.isSpouse && !p.spouseOfId) flags.push({ tone: 'error', label: '配偶未关联' });
  if (!p.isSpouse && p.gen > 1 && !p.fatherId) flags.push({ tone: 'error', label: '世系断点' });
  if (p.branchId === 'BR-UNDEF') flags.push({ tone: 'error', label: '支系未定' });
  if (['少亡', '无后'].includes(p.status) && childCount > 0) flags.push({ tone: 'warn', label: '状态矛盾' });
  const ch = GEN_CHAR_MAP[p.gen];
  if (!p.isSpouse && !p.unnamed && ch && !p.name.includes(ch)) flags.push({ tone: 'warn', label: '凡字不符' });
  if ((p.notes || []).some((n) => n.type === 'unparsed')) flags.push({ tone: 'warn', label: '旁注未归类' });
  return flags;
}
