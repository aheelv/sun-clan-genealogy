/**
 * validate.js — 校验引擎
 * ---------------------------------------------------------------
 * 规则以"注册表"形式集中管理：每条规则 = { id, level, title, desc, scope, check }。
 * 支持三个作用域：
 *   field   —— 单字段（表单实时校验）
 *   record  —— 单条人物（保存前校验）
 *   graph   —— 全谱（校验中心 / 导入后校验）
 *
 * level: error 阻断保存 | warn 提示但可保存 | info 供人工复核
 */

import { PERSON_FIELDS, GEN_CHAR_MAP, GEN_LABELS, GENDER } from './schema.js';

export const LEVEL = { ERROR: 'error', WARN: 'warn', INFO: 'info' };

const issue = (ruleId, level, message, target = {}) => ({
  ruleId, level, message, ...target,
});

/** ---------- 字段级 ---------- */
const fieldRules = [
  {
    id: 'F-NAME-REQ', field: 'name', level: LEVEL.ERROR,
    title: '谱名必填',
    check: (v) => (String(v ?? '').trim() ? null : '谱名不可为空'),
  },
  {
    id: 'F-NAME-FMT', field: 'name', level: LEVEL.ERROR,
    title: '谱名格式',
    check: (v) => {
      const s = String(v ?? '').trim();
      if (!s) return null;
      return PERSON_FIELDS.name.pattern.test(s) ? null : PERSON_FIELDS.name.patternHint;
    },
  },
  {
    id: 'F-GEN-RANGE', field: 'gen', level: LEVEL.ERROR,
    title: '世代范围',
    check: (v) => {
      const n = Number(v);
      return Number.isInteger(n) && n >= 1 && n <= 18 ? null : '世代须为 1–18 的整数';
    },
  },
  {
    id: 'F-GENDER', field: 'gender', level: LEVEL.ERROR,
    title: '性别取值',
    check: (v) => (Object.keys(GENDER).includes(v) ? null : '性别须为 男/女/待考'),
  },
];

/** ---------- 记录级 ---------- */
const recordRules = [
  {
    id: 'R-SELF-PARENT', level: LEVEL.ERROR, title: '父不可为自身',
    check: (p) => (p.fatherId && p.fatherId === p.id ? '人物的父不能是自己' : null),
  },
  {
    id: 'R-SELF-SPOUSE', level: LEVEL.ERROR, title: '配偶不可为自身',
    check: (p) => (p.spouseOfId && p.spouseOfId === p.id ? '人物的配偶不能是自己' : null),
  },
  {
    id: 'R-SPOUSE-GENDER', level: LEVEL.WARN, title: '配偶性别',
    check: (p, ctx) => {
      if (!p.spouseOfId) return null;
      const owner = ctx.get(p.spouseOfId);
      if (!owner) return '配偶指向的人物不存在';
      if (p.gender === 'M' && owner.gender === 'M') return '配偶双方均为男性，请确认';
      return null;
    },
  },
  {
    id: 'R-SPOUSE-ROLE', level: LEVEL.WARN, title: '配偶身份标记',
    check: (p) => (!p.spouseOfId || p.isSpouse ? null : '已指定夫主但未标记为配偶身份'),
  },
  {
    // 配偶不变量：spouseOfId（上向，配偶指向夫主）与 spouseIds（下向，夫主指向配偶）
    // 互斥。若配偶自身也持有 spouseIds，同一婚姻关系会被双向重复表达，
    // 界面会把夫主渲染两次、把"配 N"计数算错。
    id: 'R-SPOUSE-EXCLUSIVE', level: LEVEL.ERROR, title: '配偶字段互斥',
    check: (p) => {
      const up = p.spouseOfId, down = p.spouseIds || [];
      if (up && down.length) return '配偶自身不应再持有配偶列表，请仅保留「夫主」';
      if (up && up === p.id) return '夫主不能是自己';
      if (down.includes(p.id)) return '配偶列表中包含自身';
      return null;
    },
  },
  {
    id: 'R-UNNAMED-NAME', level: LEVEL.INFO, title: '未具名人物',
    check: (p) => (p.unnamed ? `「${p.name}」为原谱乳名／排行占位，建议补录谱名` : null),
  },
  {
    id: 'R-GENCHAR', level: LEVEL.WARN, title: '辈分字（凡字）',
    check: (p) => {
      if (p.isSpouse || p.unnamed) return null;
      const ch = GEN_CHAR_MAP[p.gen];
      if (!ch) return null;
      return p.name.includes(ch) ? null
        : `${GEN_LABELS[p.gen]}凡字应为「${ch}」，名中未见，请核对是否同辈异名或性别归属`;
    },
  },
  {
    id: 'R-STATUS-CHILD', level: LEVEL.WARN, title: '状态与子嗣',
    check: (p, ctx) => {
      if (!['少亡', '无后'].includes(p.status)) return null;
      const kids = ctx.childrenOf(p.id);
      return kids.length ? `标注为「${p.status}」却有 ${kids.length} 名子女，请核对` : null;
    },
  },
  {
    id: 'R-STATUS-ORPHAN-SPOUSE', level: LEVEL.WARN, title: '少亡却有配偶',
    check: (p) => (p.status === '少亡' && (p.spouseIds || []).length
      ? '标注为「少亡」却有配偶记录，请核对' : null),
  },
  {
    id: 'R-LIFESPAN', level: LEVEL.ERROR, title: '生卒年',
    check: (p) => {
      if (!p.birthYear || !p.deathYear) return null;
      return Number(p.deathYear) >= Number(p.birthYear) ? null : '卒年不得早于生年';
    },
  },
];

/** ---------- 全谱级 ---------- */
const graphRules = [
  {
    id: 'G-PARENT-EXISTS', level: LEVEL.ERROR, title: '父记录缺失',
    check: (ctx) => ctx.persons
      .filter((p) => p.fatherId && !ctx.get(p.fatherId))
      .map((p) => issue('G-PARENT-EXISTS', LEVEL.ERROR, `「${p.name}」的父（${p.fatherId}）不存在`, { personId: p.id })),
  },
  {
    id: 'G-GEN-STEP', level: LEVEL.ERROR, title: '世代跳跃',
    check: (ctx) => ctx.persons
      .filter((p) => p.fatherId && ctx.get(p.fatherId) && ctx.get(p.fatherId).gen + 1 !== p.gen)
      .map((p) => {
        const f = ctx.get(p.fatherId);
        return issue('G-GEN-STEP', LEVEL.ERROR,
          `「${p.name}」${GEN_LABELS[p.gen]}，父「${f.name}」${GEN_LABELS[f.gen]}，子世代应为父世代 +1`,
          { personId: p.id });
      }),
  },
  {
    id: 'G-CYCLE', level: LEVEL.ERROR, title: '世系环',
    check: (ctx) => {
      const out = [];
      for (const p of ctx.persons) {
        let cur = p, hops = 0;
        const seen = new Set([p.id]);
        while (cur && cur.fatherId && hops++ < 40) {
          if (seen.has(cur.fatherId)) {
            out.push(issue('G-CYCLE', LEVEL.ERROR, `「${p.name}」的父系链构成环`, { personId: p.id }));
            break;
          }
          seen.add(cur.fatherId);
          cur = ctx.get(cur.fatherId);
        }
      }
      return out;
    },
  },
  {
    id: 'G-ORPHAN', level: LEVEL.WARN, title: '世系断点',
    check: (ctx) => ctx.persons
      .filter((p) => !p.isSpouse && p.gen > 1 && !p.fatherId && !ctx.isBranchHead(p))
      .map((p) => issue('G-ORPHAN', LEVEL.WARN, `「${p.name}」未挂接到父辈，需人工考证`, { personId: p.id })),
  },
  {
    id: 'G-BRANCH-MISMATCH', level: LEVEL.WARN, title: '支系不一致',
    check: (ctx) => ctx.persons
      .filter((p) => p.fatherId && ctx.get(p.fatherId) && ctx.get(p.fatherId).branchId !== p.branchId)
      .map((p) => issue('G-BRANCH-MISMATCH', LEVEL.WARN,
        `「${p.name}」支系与父「${ctx.get(p.fatherId).name}」不一致`, { personId: p.id })),
  },
  {
    id: 'G-DUP-SPOUSE', level: LEVEL.WARN, title: '重复配偶',
    check: (ctx) => {
      const out = [];
      for (const p of ctx.persons) {
        const ids = p.spouseIds || [];
        if (new Set(ids).size !== ids.length) {
          out.push(issue('G-DUP-SPOUSE', LEVEL.WARN, `「${p.name}」的配偶列表存在重复项`, { personId: p.id }));
        }
      }
      return out;
    },
  },
  {
    id: 'G-DUP-NAME', level: LEVEL.INFO, title: '同世代同名',
    check: (ctx) => {
      const map = new Map();
      for (const p of ctx.persons) {
        if (p.isSpouse) continue;
        const k = `${p.gen}::${p.name}`;
        map.set(k, [...(map.get(k) || []), p]);
      }
      const out = [];
      for (const [k, list] of map) {
        if (list.length > 1) {
          const [gen, name] = k.split('::');
          out.push(issue('G-DUP-NAME', LEVEL.INFO,
            `${GEN_LABELS[gen]}「${name}」共 ${list.length} 人（同名异人，原谱另有旁注区分）`,
            { personId: list[0].id, personIds: list.map((x) => x.id) }));
        }
      }
      return out;
    },
  },
  {
    id: 'G-INFERRED', level: LEVEL.INFO, title: '推导关系待核',
    check: (ctx) => ctx.persons
      .filter((p) => p.parentEvidence === 'heuristic')
      .map((p) => issue('G-INFERRED', LEVEL.INFO, `「${p.name}」的父系由规则推导，未经原谱明载`, { personId: p.id })),
  },
  {
    id: 'G-SPOUSE-UNLINKED', level: LEVEL.ERROR, title: '配偶未关联',
    check: (ctx) => ctx.persons
      .filter((p) => p.isSpouse && !p.spouseOfId)
      .map((p) => issue('G-SPOUSE-UNLINKED', LEVEL.ERROR, `「${p.name}」未关联夫主`, { personId: p.id })),
  },
  {
    id: 'G-BRANCH-UNDEF', level: LEVEL.ERROR, title: '支系未定',
    check: (ctx) => ctx.persons
      .filter((p) => p.branchId === 'BR-UNDEF')
      .map((p) => issue('G-BRANCH-UNDEF', LEVEL.ERROR, `「${p.name}」未归属支系`, { personId: p.id })),
  },
  {
    id: 'G-UNPARSED-NOTE', level: LEVEL.WARN, title: '旁注未归类',
    check: (ctx) => {
      const out = [];
      for (const p of ctx.persons) {
        for (const n of p.notes || []) {
          if (n.type === 'unparsed') {
            out.push(issue('G-UNPARSED-NOTE', LEVEL.WARN, `「${p.name}」的旁注「${n.text}」未归类`, { personId: p.id }));
          }
        }
      }
      return out;
    },
  },
];

/** ---------- 对外 API ---------- */

/** 校验单字段 */
export function validateField(field, value) {
  return fieldRules
    .filter((r) => r.field === field)
    .map((r) => {
      const msg = r.check(value);
      return msg ? { ruleId: r.id, level: r.level, title: r.title, field, message: msg } : null;
    })
    .filter(Boolean);
}

/** 记录级校验需要复核的字段（必填与格式约束） */
const RECORD_FIELD_KEYS = ['name', 'gen', 'gender'];

/**
 * 校验单条记录 = 字段级规则（必填/格式）+ 记录级规则（自洽性）。
 * 这样「保存前校验」与「表单实时校验」共用同一套字段规则，避免两处口径漂移。
 */
export function validateRecord(person, ctx) {
  const out = [];
  for (const f of RECORD_FIELD_KEYS) out.push(...validateField(f, person[f]));
  for (const r of recordRules) {
    const msg = r.check(person, ctx);
    if (msg) out.push({ ruleId: r.id, level: r.level, title: r.title, personId: person.id, message: msg });
  }
  return out;
}

/** 全谱校验，返回按 level 分组的问题列表 */
export function validateGraph(ctx) {
  const all = [];
  for (const r of graphRules) {
    try {
      all.push(...r.check(ctx));
    } catch (e) {
      all.push(issue(r.id, LEVEL.ERROR, `规则执行异常：${e.message}`, {}));
    }
  }
  for (const p of ctx.persons) {
    all.push(...validateRecord(p, ctx).map((x) => ({ ...x, personId: p.id })));
  }
  const byLevel = { error: [], warn: [], info: [] };
  for (const i of all) byLevel[i.level]?.push(i);
  return {
    total: all.length,
    counts: { error: byLevel.error.length, warn: byLevel.warn.length, info: byLevel.info.length },
    byLevel,
    rules: [...fieldRules, ...recordRules, ...graphRules].map(({ id, level, title }) => ({ id, level, title })),
  };
}

export const RULE_COUNT = fieldRules.length + recordRules.length + graphRules.length;
