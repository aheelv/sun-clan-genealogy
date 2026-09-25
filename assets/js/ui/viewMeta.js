/**
 * ui/viewMeta.js — 视图导航元数据（唯一来源）
 * ---------------------------------------------------------------
 * 顶部导航、底部标签栏、各页「快速跳转」条三处共用这一份表。
 * 若各写一套，改一个视图名就要改三处，且极易漏改——此前顶部导航与底部
 * 标签栏的图标就是两份重复的常量。
 *
 * 零依赖叶节点：不 import 任何模块，故 app.js 与 ui/* 可同时引用而不成环。
 * 依赖方向仍是 `入口 → 视图 → 领域 → 核心 → 数据`，本文件属视图层的数据部分。
 */

/** 视图次序即导航次序：概览 → 谱系图 → 名录 → 文献 → 校验 → 权限 */
export const VIEW_META = [
  { key: 'home', label: '概览', icon: 'home', hint: '全谱概貌、支系规模与快捷检索' },
  { key: 'chart', label: '谱系图', icon: 'chart', hint: '图形化世系树，可折叠、缩放、平移' },
  { key: 'explore', label: '名录', icon: 'explore', hint: '按世代与支系筛选，世系树／列表双模式' },
  { key: 'docs', label: '文献', icon: 'docs', hint: '前言、编后话与历次校订原文' },
  { key: 'validate', label: '校验', icon: 'validate', hint: '交叉校验结果与待复核清单' },
  { key: 'admin', label: '权限', icon: 'admin', hint: '角色切换、导入导出与审计日志' },
];

/** 视图键 → 中文名，供文案拼装使用 */
export const VIEW_LABEL = Object.fromEntries(VIEW_META.map((v) => [v.key, v.label]));

/**
 * 图标（内联 SVG path，无外部依赖）。
 * 顶部导航、底部标签栏、快速跳转条共用，保证同一视图处处同一图形。
 */
export const VIEW_ICONS = {
  home: '<path d="M5 15l11-9 11 9v12H5z" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linejoin="round"/><path d="M13 27v-8h6v8" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linejoin="round"/>',
  chart: '<path d="M4 26h24M12 26V14M20 26V14M12 14V6M20 14V6M8 10h16" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  explore: '<circle cx="14" cy="14" r="8" stroke="currentColor" stroke-width="1.7" fill="none"/><path d="M20 20l6 6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  docs: '<path d="M7 5h11l5 5v16H7z" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linejoin="round"/><path d="M18 5v5h5M11 15h9M11 19h9" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/>',
  validate: '<path d="M6 6h20v20H6z" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linejoin="round"/><path d="M10 15l4 4 8-8" stroke="currentColor" stroke-width="1.9" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  admin: '<circle cx="16" cy="11" r="4.5" stroke="currentColor" stroke-width="1.7" fill="none"/><path d="M7 25c2-5 5-7 9-7s7 2 9 7" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round"/>',
  /* 以下为页面内用途，不出现在导航里 */
  genchar: '<path d="M6 10h20M6 16h20M6 22h20" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="16" cy="5" r="2" fill="currentColor"/>',
  help: '<circle cx="16" cy="16" r="11" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M12.6 12.6a3.5 3.5 0 1 1 4.6 3.3c-.9.3-1.2 1-1.2 1.9v.4" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/><circle cx="16" cy="22.6" r="1.2" fill="currentColor"/>',
};
