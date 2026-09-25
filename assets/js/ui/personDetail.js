/**
 * ui/personDetail.js — 人物详情面板
 */

import { h } from '../core/dom.js';
import { GEN_LABELS, GEN_CHAR_MAP, NOTE_TYPE, DERIVED } from '../core/schema.js';
import { PERM } from '../core/auth.js';
import { branchMeta } from '../domain/branch.js';
import { displayName, statusMeta, genderLabel } from '../domain/person.js';
import { ancestorsOf, kinshipLabel, indexById } from '../domain/relation.js';
import { avatar, badge, branchBadge, genBadge, confidenceBadge, evidenceBadge, statusBadge, personPill, pathLine, refChips, emptyState, sectionHead } from './components.js';

export function renderPersonDetail(store, person, { auth, onPick, onEdit, onDelete, onAddChild, onAddSpouse, focusId }) {
  if (!person) {
    return h('div', { class: 'card' }, h('div', { class: 'card__body' },
      emptyState('未选择人物', '在左侧列表中点击任意一位，或使用检索定位', '谱')));
  }

  const byId = indexById(store.persons);
  const father = person.fatherId ? byId.get(person.fatherId) : null;
  const children = store.childrenOf(person.id);
  const spouses = (person.spouseIds || []).map((id) => byId.get(id)).filter(Boolean);
  const owner = person.spouseOfId ? byId.get(person.spouseOfId) : null;
  const siblings = father ? store.childrenOf(father.id).filter((x) => x.id !== person.id) : [];
  const chain = [...ancestorsOf(person.id, byId).reverse(), person];

  // 过继：原谱旁注「过继给X为子」写在**生父行**，故 fatherId 恒为生父，
  //       养父（出继对象）由 adoption 关系单独表达，二者不可混同。
  const adoptOut = (store.adoptions || []).find((a) => a.fromId === person.id) || null;
  const adoptIn = (store.adoptions || []).filter((a) => a.toId === person.id);
  const adoptiveFather = adoptOut ? byId.get(adoptOut.toId) : null;
  const adoptedChildIds = new Set(adoptIn.map((a) => a.fromId));

  const canEdit = auth.can(PERM.PERSON_UPDATE);
  const canDelete = auth.can(PERM.PERSON_DELETE);
  const canRel = auth.can(PERM.RELATION_WRITE);

  const rows = [];
  const kv = (k, v) => { if (v) rows.push(h('dt', {}, k), h('dd', {}, v)); };

  kv('姓', person.surname || '—');
  kv('名', person.givenName || person.name);
  kv('性别', genderLabel(person.gender));
  kv('世代', `${GEN_LABELS[person.gen]}${GEN_CHAR_MAP[person.gen] ? `（凡字「${GEN_CHAR_MAP[person.gen]}」）` : ''}`);
  kv('支系', branchMeta(person.branchId).name);
  kv('身份', person.isSpouse ? '配偶' : '本族男丁');
  kv('注音', person.pinyin);
  kv('父', father ? personPill(father, onPick) : (person.gen > 1 ? badge('待考（世系断点）', 'warn') : null));
  kv('父系证据', person.parentEvidence ? h('span', {}, evidenceBadge(person.parentEvidence),
    ' ', confidenceBadge(person.confidence?.parent)) : null);
  kv('出继', adoptOut ? h('span', {}, '过继给 ', adoptiveFather ? personPill(adoptiveFather, onPick) : badge(adoptOut.toId, 'warn'),
    ' 为子 ', badge('原谱明载', 'jade')) : null);
  kv('入继', adoptIn.length ? h('span', {}, `承继 ${adoptIn.length} 名过继子 `, badge('原谱明载', 'jade')) : null);
  kv('状态', statusBadge(person.status) || badge('正常', 'muted'));

  const notes = (person.notes || []).filter((n) => n.type !== 'pinyin');
  const pinyinNotes = (person.notes || []).filter((n) => n.type === 'pinyin');

  return h('div', { class: 'card' },
    h('div', { class: 'detail__hero' },
      h('div', { class: 'detail__name' }, displayName(person),
        person.pinyin ? h('span', { class: 'py' }, `〔${person.pinyin}〕`) : null),
      h('div', { class: 'detail__sub' },
        `${GEN_LABELS[person.gen]} · ${branchMeta(person.branchId).short}支 · ${genderLabel(person.gender)}`),
      h('div', { class: 'detail__tags' },
        genBadge(person.gen), branchBadge(person.branchId),
        person.unnamed ? badge('未具名', 'clay') : null,
        person.namedSpouse ? badge('以全名记载', 'jade') : null,
        statusBadge(person.status),
        adoptOut ? badge('出继', 'clay') : null,
        adoptIn.length ? badge(`入继 ${adoptIn.length} 子`, 'clay') : null,
        (children.length ? badge(`${children.length} 子`, 'muted') : null),
        (spouses.length ? badge(`${spouses.length} 配`, 'muted') : null)),
      h('div', { class: 'btn-row', style: { marginTop: '14px' } },
        h('button', { class: 'btn btn--sm', disabled: !canEdit, onClick: () => onEdit(person) }, '编辑'),
        h('button', { class: 'btn btn--sm', disabled: !canRel, onClick: () => onAddChild(person) }, '添子'),
        h('button', { class: 'btn btn--sm', disabled: !canRel, onClick: () => onAddSpouse(person) }, '添配'),
        h('button', { class: 'btn btn--sm btn--danger', disabled: !canDelete, onClick: () => onDelete(person) }, '删除'),
        !canEdit ? badge('当前角色为只读', 'muted') : null)),

    h('div', { class: 'card__body' },
      h('dl', { class: 'kv' }, ...rows),

      focusId && focusId !== person.id ? h('div', { style: { marginTop: '14px' } },
        h('div', { class: 'field__label' }, '与当前关注人物的关系'),
        badge(kinshipLabel(person.id, focusId, byId).label, 'gold')) : null,

      chain.length > 1 ? h('div', { style: { marginTop: '14px' } },
        h('div', { class: 'field__label', style: { marginBottom: '5px' } }, '世系路径（自上而下）'),
        pathLine(chain, onPick)) : null,

      spouses.length || owner ? h('div', { style: { marginTop: '16px' } },
        h('div', { class: 'field__label', style: { marginBottom: '6px' } }, person.isSpouse ? '夫主' : '配偶'),
        h('div', { class: 'rel-list' },
          owner ? personPill(owner, onPick, { prefix: '夫' }) : null,
          ...spouses.map((s) => personPill(s, onPick)))) : null,

      children.length ? h('div', { style: { marginTop: '16px' } },
        h('div', { class: 'field__label', style: { marginBottom: '6px' } },
          `子女（${children.length}）${adoptedChildIds.size ? `　其中入继 ${adoptedChildIds.size} 人` : ''}`),
        h('div', { class: 'rel-list' }, ...children.map((c) => personPill(c, onPick,
          adoptedChildIds.has(c.id) ? { prefix: '继' } : {})))) : null,

      adoptIn.length ? h('div', { style: { marginTop: '16px' } },
        h('div', { class: 'field__label', style: { marginBottom: '6px' } }, `入继之子（${adoptIn.length}）`),
        h('div', { class: 'rel-list' }, ...adoptIn.map((a) => {
          const c = byId.get(a.fromId);
          const birth = c?.fatherId ? byId.get(c.fatherId) : null;
          return h('span', { class: 'adopt-pair' },
            c ? personPill(c, onPick, { prefix: '继' }) : badge(a.fromId, 'warn'),
            birth ? h('span', { class: 'adopt-pair__from' }, '生父：', personPill(birth, onPick)) : null,
            a.note ? h('span', { class: 'adopt-pair__note' }, `「${a.note}」`) : null);
        }))) : null,

      siblings.length ? h('div', { style: { marginTop: '16px' } },
        h('div', { class: 'field__label', style: { marginBottom: '6px' } }, `同父兄弟姐妹（${siblings.length}）`),
        h('div', { class: 'rel-list' }, ...siblings.slice(0, 24).map((s) => personPill(s, onPick)),
          siblings.length > 24 ? badge(`另有 ${siblings.length - 24} 人`, 'muted') : null)) : null,

      (notes.length || pinyinNotes.length) ? h('div', { style: { marginTop: '16px' } },
        h('div', { class: 'field__label', style: { marginBottom: '6px' } }, '原谱旁注'),
        h('div', { class: 'rel-list' },
          ...notes.map((n) => badge(`${NOTE_TYPE[n.type] || n.type}：${n.text}`, n.type === 'unparsed' ? 'warn' : 'gold')),
          ...pinyinNotes.map((n) => badge(`注音：${n.text}`, 'muted')))) : null,

      (person.refs || []).length ? h('div', { style: { marginTop: '16px' } },
        h('div', { class: 'field__label', style: { marginBottom: '6px' } },
          `原谱出处（共 ${person.refs.length} 处，对应《孙氏族谱.xlsx》单元格）`),
        refChips(person.refs)) : null,

      h('div', { style: { marginTop: '18px', borderTop: '1px solid var(--border-soft)', paddingTop: '12px' } },
        h('div', { class: 't-xs t-faint' },
          `编号 ${person.id}　·　数据来源：`,
          h('span', { class: 'mono' }, '孙氏族谱.xlsx / Sheet1'),
          person.parentEvidence === 'heuristic'
            ? h('div', { style: { marginTop: '6px' } }, badge('父系关系为规则推导，未经原谱明载，请在「校验中心」复核', 'clay'))
            : null))));
}
