# -*- coding: utf-8 -*-
"""
verify_data.py — 转录与谱系的独立交叉校验（不复用建模管线的任何代码）

设计立场
    校验器与建模器**必须不共享代码**。本文件只读两个东西：
      · data/source/chart-raw.json  —— 原谱逐格转录（事实基线）
      · data/genealogy.json         —— 建模产出（受检对象）
    所有推导（分页、列→世代映射、主干链、最近行候选父）都在此处**独立重算一遍**，
    再与建模产出逐项比对。若两边一致，说明管线无实现缺陷；若不一致，则暴露真实问题。

校验项
    C01 单元格往返      —— 每条出处指向的单元格，其原文必须与记录中的 raw 完全一致
    C02 页码归属        —— 每条出处标注的页码，必须与其行号所在页一致
    C03 世代与列一致    —— 每个人物的世代，必须等于其所在页该列的世代
    C04 单元格全覆盖    —— 全部非空单元格必须被 标题/表头/人物/配偶/旁注 恰好覆盖一次
    C05 主干链闭合      —— 独立重走每条主干行，相邻两格必须对应一条父系链
    C06 文献链核对      —— 《前言》明载的 8 条父子关系必须存在且证据为 doc
    C07 启发式父系重算  —— 独立重算「相邻世代列最近行男性」，须与建模结果一致
    C08 父系属性一致    —— 父须为男、非配偶、世代 +1、非自身后代
    C09 子女反向一致    —— childrenIds 必须等于「以我为父」的集合
    C10 配偶双向一致    —— spouseOfId 与 spouseIds 必须互为反向引用
    C11 计数守恒        —— 人物/配偶/旁注/出处 各类计数必须自洽且与统计字段一致
    C12 凡字独立重算    —— 独立重算凡字符合率，须与报告一致

用法
    python tools/verify_data.py            # 输出报告并打印摘要
    python tools/verify_data.py --strict   # 有任何 FAIL 时以非零码退出
"""
import json
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "source"

CN_NUM = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5,
          "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}

# 原谱明载的世系骨架（出自《孙氏族谱前言》，独立于建模脚本手工录入，用于交叉核对）
DOC_CHAINS = [
    (1, "文友", 2, "元亨"), (1, "文友", 2, "元贞"),
    (2, "元亨", 3, "仁"),
    (2, "元贞", 3, "义"), (2, "元贞", 3, "礼"), (2, "元贞", 3, "智"),
    (2, "元贞", 3, "斌"), (2, "元贞", 3, "吉"),
]

# 凡字（出自《前言》注 2/3）
GEN_CHARS = {6: "士", 7: "昌", 8: "道", 9: "德", 10: "盛",
             11: "裕", 12: "世", 13: "广", 14: "大", 15: "年",
             16: "学", 17: "成", 18: "保", 19: "国", 20: "志",
             21: "良", 22: "善", 23: "福", 24: "寿", 25: "全"}

BRANCH_HEADS = {"仁", "礼", "义", "智", "斌", "吉"}

TITLE_RE = re.compile(r"孙氏世系图表")
HEADER_RE = re.compile(r"^([一二三四五六七八九十]+)代$")
SPOUSE_RE = re.compile(r"^[\u4e00-\u9fa5]{0,2}氏$")
NAME_RE = re.compile(r"^[\u4e00-\u9fa5]{1,6}$")

# 旁注特征词：用于在"未被引用"的单元格中区分「旁注」与「疑似漏录的人名」
NOTE_HINTS = ("注：", "过继", "见", "同名", "重名", "少亡", "无后", "孤",
              "长子", "次子", "三子", "四子", "五子", "所生", "子过继",
              "一声", "二声", "三声", "四声")


# ══════════════════════════════════════════════════════════════
# 独立重建：分页 + 列→世代映射
# ══════════════════════════════════════════════════════════════
def rebuild_pages(cells):
    """从标题行切分页面，从表头行建立 列→世代 映射。"""
    title_rows = sorted(r for (r, c), v in cells.items() if c == 1 and TITLE_RE.search(v))
    pages = []
    for i, tr in enumerate(title_rows):
        hdr = tr + 1
        gen_map = {}
        for (r, c), v in cells.items():
            if r == hdr:
                m = HEADER_RE.match(v.strip())
                if m:
                    gen_map[c] = CN_NUM.get(m.group(1).replace("代", ""))
        end = title_rows[i + 1] - 1 if i + 1 < len(title_rows) else max(r for r, _ in cells)
        pages.append({"page": i + 1, "titleRow": tr, "headerRow": hdr,
                      "genMap": {k: v for k, v in gen_map.items() if v},
                      "firstRow": tr + 2, "lastRow": end})
    return pages


def page_of(pages, row):
    for pg in pages:
        if pg["titleRow"] < row <= pg["lastRow"]:
            return pg
    return None


# ══════════════════════════════════════════════════════════════
# 主流程
# ══════════════════════════════════════════════════════════════
def main():
    raw = json.loads((SRC / "chart-raw.json").read_text(encoding="utf-8"))
    sheet = next(s for s in raw["sheets"] if s["name"] == "Sheet1")
    cells = {(c["row"], c["col"]): c["value"] for c in sheet["cells"]}
    gen = json.loads((ROOT / "data" / "genealogy.json").read_text(encoding="utf-8"))

    pages = rebuild_pages(cells)
    by_id = {p["id"]: p for p in gen["persons"]}
    persons = [p for p in gen["persons"] if not p.get("isSpouse")]
    spouses = [p for p in gen["persons"] if p.get("isSpouse")]
    notes = gen.get("notes", [])

    checks = []

    def check(code, title, problems, detail="", known_re=None, known_reason=None):
        """登记一项校验。

        problems  —— 结构性不一致（必须为 0，否则判 FAIL）
        known_re  —— 正则；命中的问题转入「已知留白」，不算失败但必须可见。
                     用途：原谱本身留白（如未记明夫主），系统如实标注而非猜测，
                     这类问题应当在报告中持续可见，而不是被"校验通过"掩盖。
        """
        known, real = [], []
        for pb in problems:
            (known if (known_re and re.search(known_re, pb)) else real).append(pb)
        checks.append({"code": code, "title": title, "pass": not real,
                       "problemCount": len(real), "detail": detail,
                       "problems": real[:120],
                       "knownGapCount": len(known), "knownGapReason": known_reason,
                       "knownGaps": known[:60]})

    # ── C01 单元格往返 ──────────────────────────────────────
    problems = []
    for p in gen["persons"]:
        for r in p.get("refs", []):
            key = (r["row"], r["col"])
            if key not in cells:
                problems.append(f"{p['id']} 出处 {r['cell']} 在原谱中为空")
            elif cells[key].strip() != r["raw"].strip():
                problems.append(f"{p['id']} 出处 {r['cell']}：记录「{r['raw']}」≠ 原谱「{cells[key]}」")
    check("C01", "单元格往返（出处原文 = 原谱原文）", problems,
          f"核验 {sum(len(p.get('refs', [])) for p in gen['persons'])} 条出处")

    # ── C02 页码归属 ────────────────────────────────────────
    problems = []
    for p in gen["persons"]:
        for r in p.get("refs", []):
            pg = page_of(pages, r["row"])
            if pg is None:
                problems.append(f"{p['id']} 出处 {r['cell']} 的行号 {r['row']} 不落在任何页内")
            elif pg["page"] != r["page"]:
                problems.append(f"{p['id']} 出处 {r['cell']} 标注第 {r['page']} 页，实际第 {pg['page']} 页")
    check("C02", "页码归属（出处页码 = 行号所在页）", problems,
          f"重建页面 {len(pages)} 页")

    # ── C03 世代与列一致 ────────────────────────────────────
    problems = []
    checked = 0
    for p in gen["persons"]:
        for r in p.get("refs", []):
            pg = page_of(pages, r["row"])
            if pg is None:
                continue
            g = pg["genMap"].get(r["col"])
            if g is None:
                continue
            checked += 1
            if g != p["gen"]:
                problems.append(f"{p['id']}「{p['name']}」出处 {r['cell']} 所在列应为 {g} 世，记录为 {p['gen']} 世")
    check("C03", "世代与列一致（人物世代 = 该列世代）", problems, f"核验 {checked} 处")

    # ── C04 单元格全覆盖 ────────────────────────────────────
    used = Counter()
    for p in gen["persons"]:
        for r in p.get("refs", []):
            used[(r["row"], r["col"])] += 1
    for n in notes:
        used[(n["row"], n["col"])] += 1
    title_cells = {(r, c) for (r, c), v in cells.items() if TITLE_RE.search(v)}
    header_cells = {(r, c) for (r, c), v in cells.items() if HEADER_RE.match(v.strip())}
    blank_cells = {(r, c) for (r, c), v in cells.items() if not v.strip()}

    problems = []
    for key in cells:
        if key in title_cells or key in header_cells or key in blank_cells:
            continue
        n = used.get(key, 0)
        if n == 0:
            v = cells[key].strip()
            looks_like_note = any(h in v for h in NOTE_HINTS) or len(v) > 8
            tag = "疑似漏录的旁注" if looks_like_note else "疑似漏录的人名/配偶"
            problems.append(f"{chr(64 + key[1])}{key[0]}「{v[:24]}」未被任何记录引用（{tag}）")
        elif n > 1:
            problems.append(f"{chr(64 + key[1])}{key[0]}「{cells[key][:16]}」被 {n} 条记录重复引用")
    check("C04", "单元格全覆盖（每格恰好归属一次）", problems,
          f"非空单元格 {len(cells) - len(blank_cells)} = 标题 {len(title_cells)} "
          f"+ 表头 {len(header_cells)} + 引用 {len(used)} + 空白 {len(blank_cells)}")

    # ── C05 主干链闭合 ──────────────────────────────────────
    #   独立重走：同一行内「列号连续」的**主干人物**格（配偶格不参与世系链）构成显式世系链。
    #
    #   主干行上的相邻格（A → P）有两种合法实现：
    #     ① 父系链：fatherId[P] == A
    #     ② 过继链：P 的旁注为「过继给A为子」，此时 P 出现在养父 A 的行中承继其祧，
    #        而 fatherId 仍为生父。二者都算「明载信息已被采纳」。
    cell_to_pid = {}
    for p in persons:                      # 仅主干人物，配偶以「夫妻相并」另行归属
        for r in p.get("refs", []):
            cell_to_pid[(r["row"], r["col"])] = p["id"]

    adopt_edges = {(r["fromId"], r["toId"]) for r in gen["relations"] if r["type"] == "adoption"}

    problems = []
    chains = 0
    links = 0
    via_adoption = 0
    for pg in pages:
        rows = defaultdict(list)
        for (r, c) in cells:
            if pg["titleRow"] < r <= pg["lastRow"] and r != pg["headerRow"] and c in pg["genMap"]:
                if (r, c) in cell_to_pid:  # 只取主干人物格
                    rows[r].append(c)
        for r, cols in rows.items():
            cols.sort()
            run = []
            for c in cols:
                if not run:
                    run = [c]
                elif c == run[-1] + 1:
                    run.append(c)
                else:
                    break
            if len(run) < 2 or run[0] > 2:
                continue
            chains += 1
            for a, b in zip(run, run[1:]):
                pa, pb = cell_to_pid[(r, a)], cell_to_pid[(r, b)]
                links += 1
                if by_id[pb].get("fatherId") == pa:
                    continue
                if (pb, pa) in adopt_edges:
                    via_adoption += 1
                    continue
                problems.append(
                    f"第{pg['page']}页 第{r}行 {chr(64+a)}{r}({by_id[pa]['name']}) → "
                    f"{chr(64+b)}{r}({by_id[pb]['name']})：主干行相邻，但父系链未建立"
                    f"（记录父为 {by_id.get(by_id[pb].get('fatherId'), {}).get('name', '无')}）")
    check("C05", "主干链闭合（主干行相邻格 = 父系链或过继链）", problems,
          f"独立重走主干行 {chains} 条、相邻关系 {links} 处；"
          f"其中 {links - via_adoption - len(problems)} 处为父系链、{via_adoption} 处为过继链")

    # ── C06 文献链核对 ──────────────────────────────────────
    problems = []
    for pgen, pname, cgen, cname in DOC_CHAINS:
        ps = [p for p in persons if p["gen"] == pgen and p["name"] == pname and not p.get("unnamed")]
        cs = [p for p in persons if p["gen"] == cgen and p["name"] == cname and not p.get("unnamed")]
        if not ps:
            problems.append(f"文献所载 {pgen} 世「{pname}」未见于数据")
            continue
        if not cs:
            problems.append(f"文献所载 {cgen} 世「{cname}」未见于数据")
            continue
        for c in cs:
            if c.get("fatherId") != ps[0]["id"]:
                problems.append(
                    f"文献明载 {pname}→{cname} 未建立（{c['id']} 的父为 "
                    f"{by_id.get(c.get('fatherId'), {}).get('name', '无')}）")
            elif c.get("parentEvidence") != "doc":
                problems.append(f"{c['id']}「{cname}」的父系证据应为 doc，实为 {c.get('parentEvidence')}")
    check("C06", "文献链核对（《前言》明载 8 条父子）", problems)

    # ── C07 启发式父系独立重算 ──────────────────────────────
    #   独立重算：对每个出现格，取「同页、列号 -1、非未具名」的候选；
    #   同行者优先，否则取行距最近者（行距相同者并列，均视为合法候选）。
    #
    #   注意：建模侧在逐格推导之后还施加了 R10「组内定父」——同名同世的多次出现
    #   会按证据强度择优统一父系，且归并时对多次出现做多数表决。因此**不应**要求
    #   逐格重算结果与最终记录逐字相等；正确的判据是「可解释性」：
    #   记录下来的父，必须落在该人任一出现格的独立候选集合之中。
    #
    #   ★ 合法例外「单一父块」：原谱中一位父的子女连续书写；同一 (页, 列) 上
    #     行差 ≤ 3 的连续区段构成一个「粗块」。若块内**只有一位父**，该块子女
    #     必然全部归他——逐人「行最近」会在块边界把子女劈给相邻父（典型：
    #     第 5 页世义 J271 被判给块外的怀裕 I269），这是已知的系统性偏差。
    #     故「块内唯一父」同样计入合法候选，并单独计数以便审计。
    occ_rows = defaultdict(list)
    for p in persons:
        for r in p.get("refs", []):
            occ_rows[(r["page"], r["col"])].append((r["row"], p["id"]))

    def independent_candidates(pg_page, row, col):
        """独立重算候选父：同行优先，否则取行距最近者（并列者均视为合法候选）。"""
        cands = occ_rows.get((pg_page, col - 1), [])
        if not cands:
            return set()
        same = {pid for r, pid in cands if r == row}
        if same:
            return same
        keys = [(abs(r - row), 0 if r <= row else 1) for r, _ in cands]
        best = min(keys)
        return {pid for (r, pid), k in zip(cands, keys) if k == best}

    # 粗块独立重算（与建模脚本不共享代码）：行差 > 3 即断开。
    # 注意：块划分必须计入**配偶格**——配偶同样占据行、决定块是否连续
    #（本文件开头的 persons 已排除配偶，故此处单独取 gen["persons"] 全量）。
    blk_of, blk_span, _bid = {}, {}, 0
    _col_rows = defaultdict(set)
    for p in gen["persons"]:
        for r in p.get("refs", []):
            _col_rows[(r["page"], r["col"])].add(r["row"])
    for (pg, cl), rows in _col_rows.items():
        prev = None
        for r in sorted(rows):
            if prev is None or r - prev > 3:
                _bid += 1
            blk_of[(pg, cl, r)] = _bid
            sp = blk_span.setdefault(_bid, [r, r])
            sp[0], sp[1] = min(sp[0], r), max(sp[1], r)
            prev = r

    # 每 (页, 列) 的父候选出现格（排除配偶）
    father_occ = defaultdict(list)
    for p in persons:
        if p.get("isSpouse"):
            continue
        for r in p.get("refs", []):
            father_occ[(r["page"], r["col"])].append((r["row"], p["id"]))

    def sole_father_in_block(pg_page, row, col):
        """该子女所在粗块内若只有一位父，返回其 id，否则 None。"""
        b = blk_of.get((pg_page, col, row))
        sp = blk_span.get(b)
        if sp is None:
            return None
        uniq = {pid for r, pid in father_occ.get((pg_page, col - 1), [])
                if sp[0] <= r <= sp[1]}
        return uniq.pop() if len(uniq) == 1 else None

    problems = []
    checked = 0
    direct = 0
    grouped = 0
    sole_block = 0
    for p in persons:
        if p.get("parentEvidence") != "heuristic":
            continue
        union = set()
        sole = set()
        for r in p.get("refs", []):
            if r["col"] <= 1:
                continue
            checked += 1
            union |= independent_candidates(r["page"], r["row"], r["col"])
            s = sole_father_in_block(r["page"], r["row"], r["col"])
            if s:
                sole.add(s)
        if not union and not sole:
            continue
        if p.get("fatherId") in union:
            direct += 1
        elif p.get("fatherId") in sole:
            sole_block += 1
        else:
            grouped += 1
            problems.append(
                f"{p['id']}「{p['name']}」({p['gen']}世)：记录父为 "
                f"{by_id.get(p.get('fatherId'), {}).get('name', '无')}，"
                f"但任一出现格的独立候选为 "
                f"{'、'.join(sorted(by_id.get(x, {}).get('name', x) for x in (union | sole)))}")
    check("C07", "启发式父系可解释性（父必落在独立候选或单一父块内）", problems,
          f"重算 {checked} 处出现格；行最近直接命中 {direct} 人，"
          f"单一父块例外 {sole_block} 人，无法解释 {grouped} 人")

    # ── C08 父系属性一致 ────────────────────────────────────
    problems = []
    for p in gen["persons"]:
        fid = p.get("fatherId")
        if not fid:
            continue
        f = by_id.get(fid)
        if not f:
            problems.append(f"{p['id']} 的父 {fid} 不存在")
            continue
        if f.get("isSpouse"):
            problems.append(f"{p['id']}「{p['name']}」的父「{f['name']}」被标记为配偶")
        if f.get("gender") != "M":
            problems.append(f"{p['id']}「{p['name']}」的父「{f['name']}」性别非男")
        if f["gen"] + 1 != p["gen"]:
            problems.append(f"{p['id']}「{p['name']}」{p['gen']} 世，父「{f['name']}」{f['gen']} 世（应差 1）")
        # 环检测
        seen, cur = {p["id"]}, f
        hops = 0
        while cur and hops < 40:
            if cur["id"] in seen:
                problems.append(f"{p['id']}「{p['name']}」的父系链构成环")
                break
            seen.add(cur["id"])
            cur = by_id.get(cur.get("fatherId"))
            hops += 1
    check("C08", "父系属性一致（男/非配偶/世代+1/无环）", problems)

    # ── C09 子女反向一致 ────────────────────────────────────
    problems = []
    actual = defaultdict(set)
    for p in gen["persons"]:
        if p.get("fatherId"):
            actual[p["fatherId"]].add(p["id"])
    for p in gen["persons"]:
        declared = set(p.get("childrenIds", []))
        real = actual.get(p["id"], set())
        if declared != real:
            miss = real - declared
            extra = declared - real
            seg = []
            if miss:
                seg.append("缺 " + "、".join(sorted(miss)[:4]))
            if extra:
                seg.append("多 " + "、".join(sorted(extra)[:4]))
            problems.append(f"{p['id']}「{p['name']}」childrenIds 不一致（{'；'.join(seg)}）")
    check("C09", "子女反向一致（childrenIds = 以我为父者）", problems)

    # ── C10 配偶双向一致 ────────────────────────────────────
    #   不变量：spouseOfId（上向）与 spouseIds（下向）互斥且互为反向引用。
    #     · 配偶（isSpouse）：spouseOfId = 夫主，spouseIds 必须为空
    #     · 主干（男）：spouseOfId 为空，spouseIds = 其配偶列表
    #   若两侧都填，同一条婚姻会被双向重复表达，界面会把夫主渲染两次。
    problems = []
    for p in gen["persons"]:
        up = p.get("spouseOfId")
        down = p.get("spouseIds") or []
        if up and down:
            problems.append(f"{p['id']}「{p['name']}」同时持有夫主 {up} 与配偶列表 {down}（应互斥）")
        if up and up == p["id"]:
            problems.append(f"{p['id']}「{p['name']}」的夫主指向自身")
        if p["id"] in down:
            problems.append(f"{p['id']}「{p['name']}」的配偶列表包含自身")
        if p.get("isSpouse") and not up:
            problems.append(f"{p['id']}「{p['name']}」标记为配偶却无夫主")
        if not p.get("isSpouse") and up:
            problems.append(f"{p['id']}「{p['name']}」非配偶身份却填了夫主")
    # 反向引用：夫主的配偶列表必须包含该配偶
    for s in spouses:
        owner = s.get("spouseOfId")
        if owner is None:
            continue
        o = by_id.get(owner)
        if not o:
            problems.append(f"{s['id']}「{s['name']}」的夫主 {owner} 不存在")
        elif s["id"] not in (o.get("spouseIds") or []):
            problems.append(f"{s['id']}「{s['name']}」的夫主「{o['name']}」未回填该配偶")
    # 反向引用：配偶列表中每个 id 都必须指回该夫主
    for p in persons:
        for sid in (p.get("spouseIds") or []):
            s = by_id.get(sid)
            if not s:
                problems.append(f"{p['id']}「{p['name']}」的配偶 {sid} 不存在")
            elif s.get("spouseOfId") != p["id"]:
                problems.append(f"{p['id']}「{p['name']}」的配偶「{s['name']}」未反向指向该夫主")
    check("C10", "配偶不变量（spouseOfId ↔ spouseIds 互斥且互为反向）", problems,
          known_re=r"标记为配偶却无夫主",
          known_reason="原谱第 6 页 E326–H326 连续四格「万氏／宋氏／宫氏／崔氏」未记明夫主，"
                       "属原谱留白；系统如实标注（V006 / V012 error）而不猜测归属。")

    # ── C11 计数守恒 ────────────────────────────────────────
    stats = gen["meta"] and json.loads((ROOT / "data" / "validation-report.json")
                                       .read_text(encoding="utf-8"))["totals"]
    problems = []
    pc = sum(1 for r in gen["relations"] if r["type"] == "parent-child")
    sc = sum(1 for r in gen["relations"] if r["type"] == "spouse")
    ac = sum(1 for r in gen["relations"] if r["type"] == "adoption")
    expect = {
        "personTotal": len(gen["persons"]),
        "maleTotal": len(persons),
        "spouseTotal": len(spouses),
        "relationTotal": len(gen["relations"]),
        "parentChildRelations": pc,
        "spouseRelations": sc,
        "adoptionRelations": ac,
        "pages": len(pages),
        "sourceCells": len(cells),
        "noteTotal": len(notes),
    }
    for k, v in expect.items():
        if stats.get(k) != v:
            problems.append(f"统计字段 {k} = {stats.get(k)}，实算 {v}")
    # 父子关系数应等于有父者人数
    with_father = sum(1 for p in gen["persons"] if p.get("fatherId"))
    if pc != with_father:
        problems.append(f"父子关系 {pc} 条 ≠ 有父记录 {with_father} 人")
    # 出处引用总数应等于「被人物引用的去重单元格数」
    ref_cells = set()
    for p in gen["persons"]:
        for r in p.get("refs", []):
            ref_cells.add((r["row"], r["col"]))
    ref_total = sum(len(p.get("refs", [])) for p in gen["persons"])
    if ref_total != len(ref_cells):
        problems.append(f"出处引用总数 {ref_total} ≠ 去重单元格数 {len(ref_cells)}")
    # 全覆盖恒等式：非空单元格 = 标题 + 表头 + 人物引用 + 旁注 + 空白
    non_blank = len(cells) - len(blank_cells)
    expect_total = len(title_cells) + len(header_cells) + len(ref_cells) + len(notes)
    if non_blank != expect_total:
        problems.append(f"覆盖恒等式不成立：非空 {non_blank} ≠ 标题 {len(title_cells)} + 表头 "
                        f"{len(header_cells)} + 人物 {len(ref_cells)} + 旁注 {len(notes)} = {expect_total}")
    check("C11", "计数守恒（统计字段 = 实算值）", problems,
          f"非空 {non_blank} = 标题 {len(title_cells)} + 表头 {len(header_cells)} "
          f"+ 人物 {len(ref_cells)} + 旁注 {len(notes)}；出处引用 {ref_total} 条")

    # ── C12 凡字独立重算 ────────────────────────────────────
    strict = [p for p in persons
              if GEN_CHARS.get(p["gen"]) and not p.get("unnamed")]
    conform = [p for p in strict if GEN_CHARS[p["gen"]] in p["name"]]
    rate = len(conform) / len(strict) * 100 if strict else 100.0
    problems = []
    if rate < 90:
        problems.append(f"凡字符合率 {rate:.1f}% 低于 90% 阈值")
    report = json.loads((ROOT / "data" / "validation-report.json").read_text(encoding="utf-8"))
    v008 = next((i for i in report["issues"] if i["code"] == "V008"), None)
    mismatched = len(strict) - len(conform)
    if v008 and v008["count"] != mismatched:
        problems.append(f"报告 V008 计 {v008['count']} 例，独立重算 {mismatched} 例")
    check("C12", "凡字独立重算（第 6–15 世主干男丁）", problems,
          f"符合 {len(conform)}/{len(strict)} = {rate:.1f}%")

    # ── 汇总 ────────────────────────────────────────────────
    failed = [c for c in checks if not c["pass"]]
    gap_total = sum(c["knownGapCount"] for c in checks)
    out = {
        "generatedAt": datetime.now(timezone(timedelta(hours=8))).isoformat(timespec="seconds"),
        "method": "独立重算：不复用 tools/build_data.py 的任何代码，仅读 chart-raw.json 与 genealogy.json",
        "checks": checks,
        "summary": {"total": len(checks), "passed": len(checks) - len(failed),
                    "failed": len(failed), "knownGapTotal": gap_total},
    }
    (ROOT / "data" / "verification-report.json").write_text(
        json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")

    W = 66
    print("\n" + "═" * W)
    print("  独立交叉校验 · 转录与谱系")
    print("═" * W)
    for c in checks:
        if c["pass"] and c["knownGapCount"]:
            mark = f"✓ 通过（{c['knownGapCount']} 处已知留白）"
        elif c["pass"]:
            mark = "✓ 通过"
        else:
            mark = f"✗ {c['problemCount']} 处问题"
        print(f"  {c['code']}  {c['title']:<36} {mark}")
        if c["detail"]:
            print(f"        {c['detail']}")
        for pb in c["problems"][:5]:
            print(f"        ✗ {pb}")
        if c["problemCount"] > 5:
            print(f"        ✗ …另有 {c['problemCount'] - 5} 处，详见 verification-report.json")
        if c["knownGapCount"]:
            print(f"        ⚠ {c['knownGapReason']}")
            for pb in c["knownGaps"][:4]:
                print(f"          · {pb}")
    print("─" * W)
    print(f"  校验项 {len(checks)} 项　通过 {len(checks) - len(failed)} 项　"
          f"未通过 {len(failed)} 项　已知留白 {gap_total} 处")
    print("═" * W + "\n")

    if "--strict" in sys.argv and failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
