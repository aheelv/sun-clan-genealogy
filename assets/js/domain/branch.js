/**
 * domain/branch.js — 支系领域服务
 * 六大支系（仁、礼、义、智、斌、吉）的元数据、规模统计与代际分布。
 */

import { GEN_LABELS } from '../core/schema.js';

/** 支系元数据（与原谱目录「孙氏世系图表（一）～（七）」对应） */
export const BRANCHES = [
  { id: 'BR-ROOT', key: '始祖', name: '始祖（文友公）', short: '始祖', tone: 'gold', order: 0, desc: '一世祖文友公一脉，含二世元亨、元贞' },
  { id: 'BR-REN', key: '仁', name: '三世祖孙仁支系', short: '仁', tone: 'jade', order: 1, desc: '元亨公之子，谱称大太爷' },
  { id: 'BR-LI', key: '礼', name: '三世祖孙礼支系', short: '礼', tone: 'cinnabar', order: 2, desc: '元贞公次子，谱称三太爷；本谱篇幅最巨' },
  { id: 'BR-YI', key: '义', name: '三世祖孙义支系', short: '义', tone: 'clay', order: 3, desc: '元贞公长子，谱称二太爷' },
  { id: 'BR-ZHI', key: '智', name: '三世祖孙智支系', short: '智', tone: 'ink', order: 4, desc: '元贞公三子' },
  { id: 'BR-BIN', key: '斌', name: '三世祖孙斌支系', short: '斌', tone: 'moon', order: 5, desc: '元贞公四子' },
  { id: 'BR-JI', key: '吉', name: '三世祖孙吉支系', short: '吉', tone: 'osmanthus', order: 6, desc: '元贞公五子' },
  { id: 'BR-UNDEF', key: '未定', name: '支系待考', short: '待考', tone: 'muted', order: 9, desc: '尚未归属支系' },
];

export const BRANCH_BY_ID = Object.fromEntries(BRANCHES.map((b) => [b.id, b]));
export const branchMeta = (id) => BRANCH_BY_ID[id] || BRANCH_BY_ID['BR-UNDEF'];

/** 支系规模统计（含代际分布） */
export function branchStats(persons) {
  return BRANCHES
    .map((b) => {
      const members = persons.filter((p) => p.branchId === b.id && !p.isSpouse);
      const all = persons.filter((p) => p.branchId === b.id);
      const gens = new Map();
      for (const p of members) gens.set(p.gen, (gens.get(p.gen) || 0) + 1);
      const genArr = [...gens.entries()].sort((a, c) => a[0] - c[0]);
      return {
        ...b,
        personCount: members.length,
        totalWithSpouses: all.length,
        minGen: genArr.length ? genArr[0][0] : null,
        maxGen: genArr.length ? genArr[genArr.length - 1][0] : null,
        byGen: genArr.map(([gen, count]) => ({ gen, label: GEN_LABELS[gen], count })),
      };
    })
    .filter((b) => b.personCount > 0)
    .sort((a, b) => a.order - b.order);
}

/** 某支系的直系主干（每代取子女最多者），用于概览页"主脉"展示 */
export function mainLine(persons, branchId) {
  const byId = new Map(persons.map((p) => [p.id, p]));
  const heads = persons.filter((p) => p.branchId === branchId && p.gen === 3);
  let cur = heads.sort((a, b) => (b.childrenIds || []).length - (a.childrenIds || []).length)[0];
  const line = [];
  const seen = new Set();
  while (cur && !seen.has(cur.id) && line.length < 20) {
    seen.add(cur.id);
    line.push(cur);
    const kids = (cur.childrenIds || []).map((id) => byId.get(id)).filter(Boolean);
    cur = kids.sort((a, b) => (b.childrenIds || []).length - (a.childrenIds || []).length)[0];
  }
  return line;
}
