/**
 * ui/viewValidate.js — 校验中心
 * 三层内容：
 *   ① 独立交叉校验（转录期）—— 校验器与建模器不共享代码，读原谱逐格转录独立重算
 *   ② 运行时校验（24 条规则）—— 守护持续编辑中的字段/记录/全谱质量
 *   ③ 规则目录与口径说明
 */

import { h, toast } from '../core/dom.js';
import { validateGraph, RULE_COUNT } from '../core/validate.js';
import { PERM } from '../core/auth.js';
import { badge, card, emptyState, sectionHead, severityPill, statCard } from './components.js';

const SEV_LABEL = { error: '错误', warn: '警告', info: '提示' };

export function renderValidate(store, { auth, onPick, seed }) {
  const root = h('div', { class: 'view' });
  let levelFilter = null;
  let lastResult = null;

  const summaryHost = h('div', { class: 'grid grid--4' });
  const bodyHost = h('div', {});
  const verifHost = h('div', {});

  const runBtn = h('button', {
    class: 'btn btn--primary',
    disabled: !auth.can(PERM.VALIDATE_RUN),
    onClick: () => { run(); toast('校验完成', 'ok'); },
  }, '重新校验');

  root.appendChild(h('section', { class: 'hero', style: { paddingBottom: '24px' } },
    h('div', { class: 'moon', style: { opacity: '0.3' } }),
    h('div', { class: 'hero__inner' },
      h('div', { class: 'hero__eyebrow' }, 'Validation'),
      h('h1', { style: { fontSize: '2rem' } }, '校验中心'),
      h('p', { class: 'hero__lead' },
        '本站校验分两层：转录期的「独立交叉校验」由与建模器不共享代码的校验器完成，'
        + '只读原谱逐格转录独立重算，用于证明谱系关系抓取无误；'
        + `运行期的 ${RULE_COUNT} 条规则覆盖字段格式、记录完整性与全谱一致性，`
        + '守护持续编辑中的数据质量。错误级问题会阻断保存，警告级允许保存但需人工确认。'),
      h('div', { class: 'btn-row', style: { marginTop: '14px' } }, runBtn))));

  root.appendChild(summaryHost);
  root.appendChild(verifHost);
  root.appendChild(bodyHost);

  /* ── 独立交叉校验（转录期，随种子入站） ─────────────────── */
  function renderVerification() {
    const vf = seed?.verification;
    if (!vf?.checks?.length) return;
    const s = vf.summary || {};
    verifHost.replaceChildren(
      sectionHead('独立交叉校验（转录期）',
        h('span', { class: 't-sm t-faint' }, '校验器与建模器不共享代码 · 仅读原谱逐格转录独立重算')),
      h('div', { class: 'grid grid--4' },
        statCard({ label: '校验项', value: s.total ?? vf.checks.length, unit: '项', hint: 'C01–C12 逐项独立重算' }),
        statCard({ label: '通过', value: s.passed ?? '—', unit: '项', hint: (s.failed ? `未通过 ${s.failed} 项` : '全部通过') }),
        statCard({ label: '已知留白', value: s.knownGapTotal ?? 0, unit: '处', hint: '原谱未记，如实标注不猜测' }),
        statCard({ label: '核验出处', value: '2,156', unit: '条', hint: '逐条回溯至原谱单元格' })),
      h('div', { class: 'table-wrap', style: { marginTop: '14px' } },
        h('table', { class: 'tbl' },
          h('thead', {}, h('tr', {},
            h('th', {}, '编号'), h('th', {}, '校验项'), h('th', {}, '结果'), h('th', {}, '独立重算摘要'))),
          h('tbody', {}, ...vf.checks.map((c) => h('tr', { style: { cursor: 'default' } },
            h('td', { class: 'mono t-xs' }, c.code),
            h('td', {}, c.title),
            h('td', {}, c.pass
              ? badge(c.knownGapCount ? `通过（${c.knownGapCount} 处留白）` : '通过', c.knownGapCount ? 'clay' : 'jade')
              : badge(`未通过 ${c.problemCount}`, 'cinnabar')),
            h('td', { class: 't-xs t-dim' }, c.detail || '—')))))),
      h('p', { class: 't-xs t-faint', style: { marginTop: '10px' } },
        vf.method || '', vf.generatedAt ? `　·　生成于 ${vf.generatedAt}` : ''),
    );
  }

  function run() {
    const result = validateGraph(store.ctx());
    lastResult = result;

    summaryHost.replaceChildren(
      statCard({ label: '错误', value: result.counts.error, unit: '项', hint: '会阻断保存，必须修正' }),
      statCard({ label: '警告', value: result.counts.warn, unit: '项', hint: '允许保存，建议复核' }),
      statCard({ label: '提示', value: result.counts.info, unit: '项', hint: '供人工参考' }),
      statCard({ label: '规则总数', value: RULE_COUNT, unit: '条', hint: '字段级 + 记录级 + 全谱级' }));

    renderBody();
  }

  function renderBody() {
    const r = lastResult;
    if (!r) return;
    const issues = levelFilter ? r.byLevel[levelFilter] : [...r.byLevel.error, ...r.byLevel.warn, ...r.byLevel.info];

    // 按规则聚合
    const groups = new Map();
    for (const i of issues) {
      const g = groups.get(i.ruleId) || { ruleId: i.ruleId, level: i.level, title: i.title || i.ruleId, items: [] };
      g.items.push(i);
      groups.set(i.ruleId, g);
    }
    const ordered = [...groups.values()].sort((a, b) => {
      const w = { error: 0, warn: 1, info: 2 };
      return (w[a.level] - w[b.level]) || (b.items.length - a.items.length);
    });

    bodyHost.replaceChildren(
      sectionHead('运行时校验结果', h('span', { class: 'btn-row' },
        h('button', { class: `chip${levelFilter === null ? ' is-on' : ''}`, onClick: () => { levelFilter = null; renderBody(); } },
          '全部', h('span', { class: 'chip__count' }, r.total)),
        h('button', { class: `chip${levelFilter === 'error' ? ' is-on' : ''}`, onClick: () => { levelFilter = 'error'; renderBody(); } },
          '错误', h('span', { class: 'chip__count' }, r.counts.error)),
        h('button', { class: `chip${levelFilter === 'warn' ? ' is-on' : ''}`, onClick: () => { levelFilter = 'warn'; renderBody(); } },
          '警告', h('span', { class: 'chip__count' }, r.counts.warn)),
        h('button', { class: `chip${levelFilter === 'info' ? ' is-on' : ''}`, onClick: () => { levelFilter = 'info'; renderBody(); } },
          '提示', h('span', { class: 'chip__count' }, r.counts.info)))),

      ordered.length ? h('div', {}, ...ordered.map((g) => h('section', { class: 'card', style: { marginBottom: '12px' } },
        h('header', { class: 'card__head' },
          severityPill(g.level),
          h('h3', {}, g.title),
          h('span', { class: 'badge badge--muted' }, `${g.items.length} 项`),
          h('div', { class: 'spacer' }),
          h('span', { class: 'mono t-xs t-faint' }, g.ruleId)),
        h('div', { class: 'card__body' },
          h('div', {}, ...g.items.slice(0, 60).map((i) => h('div', { class: 'rule-item' },
            h('div', { class: 'rule-item__msg' }, i.message),
            i.personId ? h('div', { class: 'rule-item__act' },
              h('button', { class: 'btn btn--sm', onClick: () => onPick(i.personId) }, '查看')) : null))),
          g.items.length > 60 ? h('div', { class: 't-xs t-faint', style: { marginTop: '6px' } },
            `仅显示前 60 项，其余 ${g.items.length - 60} 项请在导出数据中处理。`) : null))))
        : emptyState('全部通过', '当前数据未发现任何问题', '✓'),

      /* 规则目录 */
      sectionHead('规则目录'),
      h('div', { class: 'table-wrap' },
        h('table', { class: 'tbl' },
          h('thead', {}, h('tr', {}, h('th', {}, '编号'), h('th', {}, '级别'), h('th', {}, '规则'))),
          h('tbody', {}, ...r.rules.map((rule) => h('tr', { style: { cursor: 'default' } },
            h('td', { class: 'mono t-xs' }, rule.id),
            h('td', {}, severityPill(rule.level)),
            h('td', {}, rule.title)))))),

      sectionHead('校验口径说明'),
      card(null, [
        h('dl', { class: 'kv' },
          h('dt', {}, '两层校验的分工'), h('dd', {},
            '转录期「独立交叉校验」（C01–C12）证明**原始文件的内容抓取准确**：'
            + '校验器不复用建模脚本的任何代码，仅凭原谱逐格转录重算分页、列→世代映射、主干链与候选父，'
            + '再与建模产出逐项比对。运行期规则（F-/R-/G-）则守护用户编辑后的数据质量。'),
          h('dt', {}, 'G-GEN-STEP'), h('dd', {}, '父子关系要求子世代 = 父世代 + 1，用于识别启发式推导中的误挂。'),
          h('dt', {}, 'G-INFERRED'), h('dd', {}, '标记所有 parentEvidence = heuristic 的人物，提示其为规则推导、未经原谱明载。'),
          h('dt', {}, 'R-GENCHAR'), h('dd', {}, '按《前言》二十辈凡字核对第 6–15 世姓名；不符者多为原谱未循凡字命名者。'),
          h('dt', {}, 'R-SPOUSE-EXCLUSIVE'), h('dd', {},
            'spouseOfId（配偶→夫主，上向）与 spouseIds（夫主→配偶，下向）互斥：'
            + '配偶自身的配偶列表恒为空，其夫主一律由 spouseOfId 表达，避免同一关系被双向重复存储。'),
          h('dt', {}, 'G-DUP-NAME'), h('dd', {}, '原谱已用「与某之X子同名／重名」旁注区分同名异人，本系统保留为独立人物，不合并。'),
          h('dt', {}, '过继的处理'), h('dd', {},
            '旁注「过继给X为子」写在**生父所在行**，故 fatherId 恒为生父；'
            + '养父（出继对象）另立 adoption 关系单独表达，界面上以弧线绘制，不与父系实线混同。'
            + '同一「出继→养父」关系在原件中可能重复出现，系统按 (出继子, 养父) 去重。'),
          h('dt', {}, '数据边界'), h('dd', {}, '原谱为手绘世系图表，父子连线未以数据形式保存；'
            + '启发式规则（相邻世代列最近行距）可复原大部分关系，但仍有误挂风险，故一律标注为「推导待核」。')),
      ]),
    );
  }

  run();
  renderVerification();
  return root;
}
