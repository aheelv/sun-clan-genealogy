/**
 * schema.js — 通用族谱数据模式（Genealogy Schema）v1.0
 * ---------------------------------------------------------------
 * 本文件是数据模型的唯一权威定义：字段、类型、约束、枚举、权限敏感级别。
 * 校验引擎（core/validate.js）、表单（ui/form.js）、导入导出（ui/dataPanel.js）
 * 全部从这里读取定义，避免"三处各写一遍"的漂移。
 *
 * 设计原则
 *  P1 单一事实来源：人物(persons)为 SSOT；父子/婚姻关系由字段派生，不重复存储。
 *  P2 溯源优先：每条记录保留原谱出处（页码 / 单元格），可回溯到 xlsx 原始格子。
 *  P3 置信度显式化：explicit（原谱明载）与 inferred（推导）严格区分。
 *  P4 枚举收敛：性别、状态、支系、证据类型均为闭集，新增须改本文件。
 */

/** 字段类型 */
export const T = {
  STRING: 'string',
  TEXT: 'text',
  INT: 'int',
  ENUM: 'enum',
  REF: 'ref',          // 指向单个人物 id
  REF_LIST: 'refList', // 指向多个人物 id
  REFS: 'refs',        // 出处数组 [page,row,col,raw]
  JSON: 'json',
};

/** 性别 */
export const GENDER = {
  M: { key: 'M', label: '男', symbol: '乾' },
  F: { key: 'F', label: '女', symbol: '坤' },
  U: { key: 'U', label: '待考', symbol: '—' },
};

/** 人物状态（源自原谱旁注） */
export const PERSON_STATUS = {
  normal: { key: 'normal', label: '正常', tone: 'ok' },
  '少亡': { key: '少亡', label: '少亡', tone: 'muted' },
  '孤': { key: '孤', label: '孤', tone: 'muted' },
  '无后': { key: '无后', label: '无后', tone: 'muted' },
};

/** 关系类型 */
export const RELATION_TYPE = {
  PARENT_CHILD: { key: 'parent-child', label: '父子', directed: true, forward: '父', backward: '子' },
  SPOUSE: { key: 'spouse', label: '婚姻', directed: false, forward: '夫', backward: '妻' },
  ADOPTION: { key: 'adoption', label: '过继', directed: true, forward: '出继于', backward: '承继自' },
};

/** 证据强度（数值越大越强；用于冲突消解） */
export const EVIDENCE = {
  doc: { key: 'doc', label: '文献明载', strength: 3, tone: 'gold' },
  spine: { key: 'spine', label: '原谱主干行', strength: 2, tone: 'jade' },
  heuristic: { key: 'heuristic', label: '规则推导', strength: 1, tone: 'clay' },
  manual: { key: 'manual', label: '人工录入', strength: 4, tone: 'cinnabar' },
  adjacency: { key: 'adjacency', label: '夫妻相并', strength: 3, tone: 'jade' },
  note: { key: 'note', label: '旁注明载', strength: 3, tone: 'gold' },
};

export const CONFIDENCE = {
  explicit: { key: 'explicit', label: '原谱明载', tone: 'gold' },
  inferred: { key: 'inferred', label: '推导待核', tone: 'clay' },
  manual: { key: 'manual', label: '人工核定', tone: 'cinnabar' },
  'n/a': { key: 'n/a', label: '不适用', tone: 'muted' },
  unknown: { key: 'unknown', label: '待考', tone: 'muted' },
};

/** 旁注类型 */
export const NOTE_TYPE = {
  cross_reference: '参见他页',
  adoption: '过继（指名养父）',
  birth_father: '生父旁注（指名生父）',
  adoption_ref: '过继旁注·未指名被注人',
  name_collision: '同名异人',
  mother_note: '生母',
  birth_order: '排行',
  infant_name: '乳名',
  pinyin: '生僻字注音',
  status: '状态',
  unparsed: '未归类旁注',
};

/**
 * 人物字段模式。
 *  access: 修改该字段所需的最低权限（core/auth.js 的 PERM 键）
 */
export const PERSON_FIELDS = {
  id: {
    type: T.STRING, label: '编号', required: true, immutable: true, access: 'person:update',
    hint: '系统生成的稳定标识，创建后不可修改',
  },
  name: {
    type: T.STRING, label: '谱名', required: true, min: 1, max: 8,
    pattern: /^[\u4e00-\u9fa5]{1,6}([a-z]{2,6})?$/,
    patternHint: '须为 1–6 个汉字（生僻字可附拼音，如「繡xiu」）',
    access: 'person:update', placeholder: '如：士聪',
  },
  surname: {
    type: T.STRING, label: '姓', required: false, max: 2,
    pattern: /^[\u4e00-\u9fa5]{0,2}$/, access: 'person:update',
    hint: '男性默认「孙」；配偶填娘家姓',
  },
  givenName: {
    type: T.STRING, label: '名', required: false, max: 6, access: 'person:update',
    hint: '配偶以全名记载时的名（如「德贤」）',
  },
  gender: {
    type: T.ENUM, label: '性别', required: true, options: Object.keys(GENDER), access: 'person:update',
  },
  isSpouse: {
    type: T.ENUM, label: '身份', required: true, options: ['false', 'true'], access: 'person:update',
    hint: '配偶以「X氏」或全名附于夫主之后',
  },
  gen: {
    type: T.INT, label: '世代', required: true, min: 1, max: 18, access: 'person:structure',
    hint: '一世祖文友公为第 1 世；原谱图表第 2 页起列标题为三代至十八代',
  },
  branchId: {
    type: T.ENUM, label: '支系', required: true, access: 'person:structure',
    options: ['BR-ROOT', 'BR-REN', 'BR-LI', 'BR-YI', 'BR-ZHI', 'BR-BIN', 'BR-JI', 'BR-UNDEF'],
  },
  status: {
    type: T.ENUM, label: '状态', required: true, options: Object.keys(PERSON_STATUS), access: 'person:update',
  },
  pinyin: { type: T.STRING, label: '注音', required: false, max: 12, access: 'person:update' },
  fatherId: {
    type: T.REF, label: '父', required: false, access: 'relation:write',
    hint: '留空表示世系断点，将在校验中心提示',
  },
  spouseOfId: {
    type: T.REF, label: '夫主', required: false, access: 'relation:write',
    hint: '仅配偶身份填写；配偶自身的配偶列表恒为空，夫主一律由此字段表达',
  },
  spouseIds: {
    type: T.REF_LIST, label: '配偶', required: false, access: 'relation:write',
    hint: '本人的配偶（下向）。与 spouseOfId 互斥，同一关系不双向重复存储',
  },
  notes: { type: T.JSON, label: '旁注', required: false, access: 'person:update' },
  refs: { type: T.REFS, label: '原谱出处', required: false, access: 'person:update' },
};

/** 编辑表单暴露的字段（顺序即表单顺序） */
export const FORM_FIELDS = [
  'name', 'surname', 'givenName', 'gender', 'isSpouse', 'gen', 'branchId',
  'status', 'pinyin', 'fatherId', 'spouseOfId',
];

/** 由其他字段推导、不入库的派生字段 */
export const DERIVED = {
  fullName: (p) => (p.isSpouse ? p.name : (p.name.startsWith('孙') ? p.name : '孙' + p.name)),
  genLabel: (p) => GEN_LABELS[p.gen] || `${p.gen}世`,
  isExplicit: (p) => p.parentEvidence === 'doc' || p.parentEvidence === 'spine' || p.parentEvidence === 'note',
};

const CN = '零一二三四五六七八九';
export function cnNum(n) {
  if (n < 10) return CN[n];
  if (n === 10) return '十';
  if (n < 20) return '十' + CN[n - 10];
  return CN[Math.floor(n / 10)] + '十' + (n % 10 ? CN[n % 10] : '');
}
export const GEN_LABELS = Object.fromEntries(
  Array.from({ length: 30 }, (_, i) => [i + 1, cnNum(i + 1) + '世'])
);

/** 凡字（辈分字）——出自《孙氏族谱前言》注 2/3 */
export const GEN_CHARS = [
  { gen: 6, char: '士', position: '中', proposer: '士仁公' },
  { gen: 7, char: '昌', position: '下', proposer: '士仁公' },
  { gen: 8, char: '道', position: '中', proposer: '士仁公' },
  { gen: 9, char: '德', position: '下', proposer: '士仁公' },
  { gen: 10, char: '盛', position: '中', proposer: '士仁公' },
  { gen: 11, char: '裕', position: '下', proposer: '士仁公' },
  { gen: 12, char: '世', position: '中', proposer: '士仁公' },
  { gen: 13, char: '广', position: '下', proposer: '士仁公' },
  { gen: 14, char: '大', position: '中', proposer: '士仁公' },
  { gen: 15, char: '年', position: '下', proposer: '士仁公' },
  { gen: 16, char: '学', position: '中', proposer: '道公公' },
  { gen: 17, char: '成', position: '下', proposer: '道公公' },
  { gen: 18, char: '保', position: '中', proposer: '道公公' },
  { gen: 19, char: '国', position: '下', proposer: '道公公' },
  { gen: 20, char: '志', position: '中', proposer: '道公公' },
  { gen: 21, char: '良', position: '下', proposer: '道公公' },
  { gen: 22, char: '善', position: '中', proposer: '道公公' },
  { gen: 23, char: '福', position: '下', proposer: '道公公' },
  { gen: 24, char: '寿', position: '中', proposer: '道公公' },
  { gen: 25, char: '全', position: '下', proposer: '道公公' },
];
export const GEN_CHAR_MAP = Object.fromEntries(GEN_CHARS.map((g) => [g.gen, g.char]));

/** 导出/导入文件格式版本 */
export const SCHEMA_VERSION = '1.0.0';
