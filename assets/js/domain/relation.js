/**
 * domain/relation.js — 世系关系领域服务
 * 纯函数，不依赖 DOM / 存储；输入人物数组，输出树、路径与亲属称谓。
 */

/** 建索引 */
export function indexById(persons) {
  return new Map(persons.map((p) => [p.id, p]));
}

/** 建子女索引 */
export function indexChildren(persons) {
  const m = new Map();
  for (const p of persons) {
    if (!p.fatherId) continue;
    if (!m.has(p.fatherId)) m.set(p.fatherId, []);
    m.get(p.fatherId).push(p);
  }
  for (const [, list] of m) list.sort((a, b) => a.id.localeCompare(b.id));
  return m;
}

/** 祖先链（自下而上） */
export function ancestorsOf(id, byId, limit = 40) {
  const out = [];
  let cur = byId.get(id);
  while (cur && cur.fatherId && out.length < limit) {
    const f = byId.get(cur.fatherId);
    if (!f) break;
    out.push(f);
    cur = f;
  }
  return out;
}

/** 后代集合（广度优先） */
export function descendantsOf(id, childMap, limit = 5000) {
  const out = [];
  const queue = [...(childMap.get(id) || [])];
  while (queue.length && out.length < limit) {
    const p = queue.shift();
    out.push(p);
    queue.push(...(childMap.get(p.id) || []));
  }
  return out;
}

/** 环检测：返回构成环的人物 id 列表 */
export function detectCycles(persons) {
  const byId = indexById(persons);
  const bad = new Set();
  for (const p of persons) {
    const seen = new Set([p.id]);
    let cur = p, hops = 0;
    while (cur?.fatherId && hops++ < 60) {
      if (seen.has(cur.fatherId)) { bad.add(p.id); break; }
      seen.add(cur.fatherId);
      cur = byId.get(cur.fatherId);
    }
  }
  return [...bad];
}

/** 两位人物的共同祖先（返回最近的一位及其到双方的距离） */
export function commonAncestor(aId, bId, byId) {
  const aChain = ancestorsOf(aId, byId);
  const bChain = ancestorsOf(bId, byId);
  const bPos = new Map(bChain.map((p, i) => [p.id, i]));
  for (let i = 0; i < aChain.length; i++) {
    const hit = bPos.get(aChain[i].id);
    if (hit !== undefined) return { ancestor: aChain[i], da: i + 1, db: hit + 1 };
  }
  return null;
}

const UP = ['', '父', '祖父', '曾祖父', '高祖父', '天祖父', '烈祖父', '太祖父', '远祖父', '鼻祖父'];
const UP_F = ['', '母', '祖母', '曾祖母', '高祖母', '天祖母', '烈祖母', '太祖母', '远祖母', '鼻祖母'];
const DOWN = ['', '子', '孙', '曾孙', '玄孙', '来孙', '晜孙', '仍孙', '云孙', '耳孙'];
const DOWN_F = ['', '女', '孙女', '曾孙女', '玄孙女', '来孙女', '晜孙女', '仍孙女', '云孙女', '耳孙女'];
/** 旁系前缀：r = 共同祖先到双方的代数较小值 − 1（r=1 堂，r=2 再从……） */
const COUSIN = ['', '堂', '再从', '三从', '四从', '五从', '六从'];
const NEPHEW = ['', '侄', '侄孙', '侄曾孙', '侄玄孙', '侄来孙', '侄晜孙'];

/**
 * 亲属称谓。
 * 语义约定：`kinshipLabel(a, b)` 回答「**a 是 b 的什么人**」。
 * 返回 { label, kind, distance }；本谱为父系单线谱，旁系称谓按共同祖先推算。
 */
export function kinshipLabel(aId, bId, byId) {
  if (aId === bId) return { label: '本人', kind: 'self', distance: 0 };
  const a = byId.get(aId), b = byId.get(bId);
  if (!a || !b) return { label: '—', kind: 'unknown', distance: null };

  // 直系（a 为长辈）：b 的祖先链中含 a
  const upIdx = ancestorsOf(bId, byId).findIndex((p) => p.id === aId);
  if (upIdx >= 0) {
    const d = upIdx + 1;
    const table = a.gender === 'F' ? UP_F : UP;
    return { label: table[d] || `${d}世祖`, kind: 'ancestor', distance: d };
  }
  // 直系（a 为晚辈）：a 的祖先链中含 b
  const dnIdx = ancestorsOf(aId, byId).findIndex((p) => p.id === bId);
  if (dnIdx >= 0) {
    const d = dnIdx + 1;
    const table = a.gender === 'F' ? DOWN_F : DOWN;
    return { label: table[d] || `${d}世孙`, kind: 'descendant', distance: d };
  }

  // 旁系：按共同祖先推算
  const ca = commonAncestor(aId, bId, byId);
  if (!ca) return { label: '同宗远支', kind: 'unrelated', distance: null };
  const r = Math.min(ca.da, ca.db) - 1;
  const fem = a.gender === 'F';

  if (r <= 0) { // 同胞
    const older = a.gen !== b.gen ? a.gen < b.gen : String(a.id) < String(b.id);
    return { label: fem ? (older ? '姐' : '妹') : (older ? '兄' : '弟'), kind: 'sibling', distance: 0 };
  }

  const prefix = COUSIN[r] || `${r}从`;
  const d = Math.abs((a.gen ?? 0) - (b.gen ?? 0));
  if (d === 0) return { label: `${prefix}${fem ? '姐妹' : '兄弟'}`, kind: 'collateral', distance: 0 };
  if ((a.gen ?? 0) < (b.gen ?? 0)) {
    // a 为长辈旁系（伯叔/姑母）
    return { label: `${prefix}${fem ? '姑母' : '伯叔'}`, kind: 'collateral-senior', distance: d };
  }
  // a 为晚辈旁系（侄辈）
  const nep = NEPHEW[d] || `侄${d}世孙`;
  return { label: fem ? nep.replace('侄', '侄女') : nep, kind: 'collateral', distance: d };
}

/**
 * 构建世系树（供树视图使用）。
 * @param {Array} persons
 * @param {{rootIds?:string[], childMap?:Map, maxDepth?:number}} opts
 */
export function buildTree(persons, { rootIds, childMap, maxDepth = 99 } = {}) {
  const byId = indexById(persons);
  const cm = childMap || indexChildren(persons);
  const roots = rootIds && rootIds.length
    ? rootIds.map((id) => byId.get(id)).filter(Boolean)
    : persons.filter((p) => !p.isSpouse && (!p.fatherId || !byId.has(p.fatherId)));

  const seen = new Set();
  const node = (p, depth) => {
    const kids = depth >= maxDepth ? [] : (cm.get(p.id) || []);
    return { person: p, depth, children: kids.map((k) => node(k, depth + 1)) };
  };
  const out = [];
  for (const r of roots) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(node(r, 0));
  }
  return out;
}

/** 统计树规模 */
export function treeSize(nodes) {
  return nodes.reduce((n, x) => n + 1 + treeSize(x.children), 0);
}

/** 从根到目标人物的路径（用于"世系路径"面包屑） */
export function pathToRoot(id, byId) {
  const chain = ancestorsOf(id, byId).reverse();
  const self = byId.get(id);
  return self ? [...chain, self] : chain;
}
