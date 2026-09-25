# -*- coding: utf-8 -*-
"""
build_data.py — 从原始转录构建规范化族谱数据集
（转录 → 分类 → 实体归并 → 关系推导 → 支系传播 → 校验 → 输出）

输入（SSOT）:  data/source/chart-raw.json  +  data/source/doc-text.json
输出:          data/genealogy.json  data/intro.json  data/validation-report.json

规则编号（详见 docs/03-数据模型与校验规范.md）：
  R1 世代由页内列标题行决定（第1页 A=一代…；第2页起 A=三代…）
  R2 配偶 = 同列紧邻其后的「X氏」单元格
  R3 注记 = 同页最近人物（|Δ行|, |Δ列| 最小）
  R4 主干行（spine）连续列 = 显式世系链，evidence=spine
  R5 启发式父子 = 相邻世代列逐人「行距最近」+ **单一父块修正**，evidence=heuristic
  R6 文献明载（《前言》）覆盖，evidence=doc
  R7 支系 = 三世祖支系头名 / 沿父系继承
"""
import json
import re
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "source"
CST = timezone(timedelta(hours=8))

CN_NUM = "零一二三四五六七八九"


def cn_num(n):
    if n < 10:
        return CN_NUM[n]
    if n == 10:
        return "十"
    if n < 20:
        return "十" + CN_NUM[n - 10]
    return CN_NUM[n // 10] + "十" + (CN_NUM[n % 10] if n % 10 else "")


GEN_LABEL = {g: cn_num(g) + "世" for g in range(1, 31)}

GEN_CHARS = [
    (6, "士", "中"), (7, "昌", "下"), (8, "道", "中"), (9, "德", "下"), (10, "盛", "中"),
    (11, "裕", "下"), (12, "世", "中"), (13, "广", "下"), (14, "大", "中"), (15, "年", "下"),
    (16, "学", "中"), (17, "成", "下"), (18, "保", "中"), (19, "国", "下"), (20, "志", "中"),
    (21, "良", "下"), (22, "善", "中"), (23, "福", "下"), (24, "寿", "中"), (25, "全", "下"),
]
GEN_CHAR_MAP = {g: c for g, c, _ in GEN_CHARS}
GEN_CHAR_POS = {g: p for g, _, p in GEN_CHARS}

BRANCH_META = {
    "始祖": ("BR-ROOT", "始祖（文友公）", "一世祖文友公一脉，二世元亨、元贞"),
    "仁":   ("BR-REN", "三世祖孙仁支系", "元亨公之子，谱称大太爷"),
    "礼":   ("BR-LI",  "三世祖孙礼支系", "元贞公次子，谱称三太爷"),
    "义":   ("BR-YI",  "三世祖孙义支系", "元贞公长子，谱称二太爷"),
    "智":   ("BR-ZHI", "三世祖孙智支系", "元贞公三子"),
    "斌":   ("BR-BIN", "三世祖孙斌支系", "元贞公四子"),
    "吉":   ("BR-JI",  "三世祖孙吉支系", "元贞公五子"),
}
BRANCH_HEADS = {"仁", "礼", "义", "智", "斌", "吉"}

DOC_EXPLICIT_CHAINS = [
    (1, "文友", [(2, "元亨"), (2, "元贞")]),
    (2, "元亨", [(3, "仁")]),
    (2, "元贞", [(3, "义"), (3, "礼"), (3, "智"), (3, "斌"), (3, "吉")]),
]

# ── 人工核定表（作者核对原谱后订正，优先级高于一切启发式）──────────────
#
# 族谱是不可再生史料，凡「机器推不出来」或「推出与作者核对结果不符」之处，
# 一律以**人工核定**为准并在此留档，而不是让启发式继续猜。
#
# 每项格式：(page, cell, child_name, child_gen, father_cell, father_name, 理由)
#   page/cell      —— 子女所在原谱单元格（如第 5 页 J271）
#   father_cell    —— 核定后的父所在单元格
#
# 已核定：第 5 页「世义」(J271) 与其妻「曲莲花」(J272) 归属**庆裕**(I276) 一支。
#   行距最近规则会把它挂到更近的怀裕(I269)，但作者核对原谱后确认应归庆裕；
#   庆裕一支的世字辈为 世义、世伦、世鹏、世敏、世高、世元 共六人（J271–J282），
#   怀裕(I269) 名下无子嗣。原谱该处排布不规则，故以人工核定覆盖。
AUTHOR_VERIFIED_PARENT = [
    (5, "J271", "世义", 12, "I276", "庆裕",
     "作者（孙智广）核对原谱第 5 页：世义、曲莲花属庆裕一支，非怀裕"),
]

PY_SYL = r"(?:一声|二声|三声|四声|1声|2声|3声|4声)"
NOTE_RULES = [
    ("cross_reference", re.compile(r"^见\s*0?(\d+)\s*页$")),
    # 「生父旁注」必须先于通用「过继」规则匹配：它同样含「过继」二字，
    # 但语义是**指名生父**（「为X之N子过继」＝此人为 X 之第 N 子，因过继而来），
    # 与「过继给Y为子」（指名养父）方向相反，须分别归类。
    ("birth_father",    re.compile(r"^为([\u4e00-\u9fa5]{1,4}?)(?:之)?([长次三四五])子过继$")),
    ("birth_father",    re.compile(r"^[（(]([\u4e00-\u9fa5]{1,4}?)([长次三四五])子过继[)）]$")),
    # 「X之N子过继」「X长子过继」「X过继」——**无「为」字**的过继旁注（原谱常见）。
    #   与「为X之N子过继」同义：指名生父 X。但**不指名被注人**——此处原谱只余
    #   一句旁注，其人已失名。若漏收，会被 PERSON_RE 当作人名，凭空生成「假人」
    #   （实例：第 14 页「道和长子过继」、第 4 页「道恕过继」）。
    #   归入**惰性**旁注 adoption_ref：只留档待考，绝不改动任何父系
    #   （因其无法可靠判定被注人，若按 birth_father 处理会被就近误挂到旁人）。
    ("adoption_ref",    re.compile(r"^([\u4e00-\u9fa5]{1,4}?)(?:之)?([长次三四五])子过继$")),
    ("adoption_ref",    re.compile(r"^([\u4e00-\u9fa5]{1,4}?)(?:之)?过继$")),
    ("adoption",        re.compile(r"过继")),
    ("name_collision",  re.compile(r"(同名|重名)")),
    ("mother_note",     re.compile(r"^([\u4e00-\u9fa5]{1,3}氏)生$")),
    ("mother_note",     re.compile(r"孩子为[\u4e00-\u9fa5]{1,3}氏所生")),
    ("birth_order",     re.compile(r"^[\u4e00-\u9fa5]{1,4}?之?[长次三四五]子$")),
    ("infant_name",     re.compile(r"^乳名$")),
    ("pinyin",          re.compile(r"^[a-z]+\s*" + PY_SYL + r"$", re.I)),
    ("pinyin",          re.compile(r"^" + PY_SYL + r"$")),
]
STATUS_RULES = [
    ("少亡", re.compile(r"^少亡$")),
    ("孤",   re.compile(r"^孤$")),
    ("无后", re.compile(r"^无后$")),
]
UNNAMED = {"二子", "三子", "财子", "平子", "长子", "四子", "五子"}
SPOUSE_RE = re.compile(r"^[\u4e00-\u9fa5]{0,2}氏$")
PERSON_RE = re.compile(r"^[\u4e00-\u9fa5]{1,6}$")
PINYIN_IN_NAME_RE = re.compile(r"^([\u4e00-\u9fa5]{1,4}?)([a-z]{2,6})$")
ADOPT_OUT_RE = re.compile(r"^过继给([\u4e00-\u9fa5]{1,6})为子$")
ADOPT_SRC_RE = re.compile(r"^([\u4e00-\u9fa5]{1,6}?)(?:之)?([长次三四五])子(?:过继)?$")
ADOPT_PAREN_RE = re.compile(r"^[（(]([\u4e00-\u9fa5]{1,6})([次长三四五])子过继[)）]$")
ADOPT_SELF_RE = re.compile(r"^([\u4e00-\u9fa5]{1,6}?)([长次三四五])子过继$")


def classify(raw):
    t = raw.strip()
    if not t or "孙氏世系图表" in t:
        return ("skip", {})
    for code, rx in STATUS_RULES:
        if rx.match(t):
            return ("status", {"status": code, "raw": t})
    for code, rx in NOTE_RULES:
        m = rx.match(t)
        if m:
            d = {"noteType": code, "raw": t}
            if code == "cross_reference":
                d["targetPage"] = int(m.group(1))
            if code == "mother_note":
                d["motherSurname"] = m.group(1) if m.groups() else None
            if code == "birth_father":
                d["birthFatherName"] = m.group(1)
                d["birthOrder"] = m.group(2)
            if code == "adoption_ref":
                d["refName"] = m.group(1)
                d["birthOrder"] = m.group(2) if (m.lastindex or 0) >= 2 else None
            return ("note", d)
    if t in UNNAMED:
        return ("unnamed", {"raw": t})
    if SPOUSE_RE.match(t):
        return ("spouse", {"surname": t.replace("氏", ""), "raw": t})
    m = PINYIN_IN_NAME_RE.match(t)
    if m:
        return ("person", {"name": m.group(1), "pinyin": m.group(2), "raw": t})
    if PERSON_RE.match(t):
        return ("person", {"name": t, "pinyin": None, "raw": t})
    return ("note", {"noteType": "unparsed", "raw": t})


def cn_to_int(s):
    if s == "十":
        return 10
    if s.startswith("十"):
        return 10 + CN_NUM.index(s[1])
    if "十" in s:
        a, b = s.split("十")
        return CN_NUM.index(a) * 10 + (CN_NUM.index(b) if b else 0)
    return CN_NUM.index(s)


def load_pages():
    raw = json.loads((SRC / "chart-raw.json").read_text(encoding="utf-8"))
    sheet = next(s for s in raw["sheets"] if s["name"] == "Sheet1")
    by_cell = {(c["row"], c["col"]): c["value"] for c in sheet["cells"]}
    title_rows = sorted(r for (r, col), v in by_cell.items()
                        if col == 1 and "孙氏世系图表" in v)
    pages = []
    for i, tr in enumerate(title_rows):
        hdr = tr + 1
        gen_map = {}
        for (r, col), v in by_cell.items():
            if r == hdr and re.match(r"^[一二三四五六七八九十]+代$", v.strip()):
                gen_map[col] = cn_to_int(v.strip().replace("代", ""))
        end = title_rows[i + 1] - 1 if i + 1 < len(title_rows) else sheet["maxRow"]
        cells = [{"row": r, "col": c, "value": v}
                 for (r, c), v in sorted(by_cell.items())
                 if tr < r <= end and r != hdr]
        note = next((v.strip() for (r, c), v in by_cell.items()
                     if r == 50 and c == 1 and v.strip().startswith("注：")), None)
        pages.append({"page": i + 1, "titleRow": tr, "headerRow": hdr,
                      "genMap": gen_map, "cells": cells, "note": note,
                      "firstRow": tr + 2, "lastRow": end})
    return pages


# ══════════════════════════════════════════════════════════════
def build():
    pages = load_pages()
    occs, notes, oid = [], [], 0
    for pg in pages:
        for cell in pg["cells"]:
            gen = pg["genMap"].get(cell["col"])
            if gen is None:
                continue
            kind, pay = classify(cell["value"])
            if kind == "skip":
                continue
            ref = f"{chr(64 + cell['col'])}{cell['row']}"
            base = {"page": pg["page"], "row": cell["row"], "col": cell["col"],
                    "gen": gen, "ref": ref, "raw": cell["value"]}
            if kind in ("person", "unnamed"):
                oid += 1
                base.update({"oid": oid, "kind": "person",
                             "name": pay.get("name") or pay["raw"],
                             "pinyin": pay.get("pinyin"),
                             "unnamed": kind == "unnamed"})
                occs.append(base)
            elif kind == "spouse":
                oid += 1
                base.update({"oid": oid, "kind": "spouse", "surname": pay["surname"],
                             "named": False, "display": pay["surname"] + "氏" if pay["surname"] else "氏"})
                occs.append(base)
            else:
                base.update({"kind": "note", **pay})
                notes.append(base)

    persons = [o for o in occs if o["kind"] == "person"]
    spouses = [o for o in occs if o["kind"] == "spouse"]
    by_oid = {p["oid"]: p for p in persons}

    # ── R2a 凡字判性：第6–15世凡字严格，名中无凡字者判为配偶 ──
    #      （原谱自盛字辈起改以全名记女性，如「迟德贤」「桑凤兰」）
    #      判定条件：该单元格在同列中的「紧邻上一格」是男性 —— 原谱夫妻相并排列。
    male_occs = []
    for p in persons:
        ch = GEN_CHAR_MAP.get(p["gen"])
        p["suspectSpouse"] = bool(ch and not p["unnamed"] and ch not in p["name"])
        if not p["suspectSpouse"]:
            male_occs.append(p)

    col_index = defaultdict(list)
    for m in male_occs:
        col_index[(m["page"], m["col"])].append(m)

    def immediate_preceding_male(o):
        c = [m for m in col_index.get((o["page"], o["col"]), []) if m["row"] < o["row"]]
        if not c:
            return None
        top = max(c, key=lambda m: m["row"])
        # 紧邻上一格必须本身是男性；中间夹了别的单元格则视为独立人物
        return top if o["row"] - top["row"] <= 2 else None

    converted = []
    for p in sorted([x for x in persons if x["suspectSpouse"]],
                    key=lambda x: (x["page"], x["col"], x["row"])):
        m = immediate_preceding_male(p)
        if m is None:
            p["suspectSpouse"] = False       # 保留为人物，交由校验中心提示
            male_occs.append(p)
            col_index[(p["page"], p["col"])].append(p)
            continue
        persons.remove(p)
        p["kind"] = "spouse"
        p["named"] = True
        p["surname"] = p["name"][0]
        p["givenName"] = p["name"][1:]
        p["spouseOf"] = m["oid"]
        p["display"] = p["name"]
        spouses.append(p)
        converted.append(p)
    by_oid = {p["oid"]: p for p in persons}

    # R4 主干行显式链
    spine_rows, explicit_pairs = [], set()
    rows_by_page = defaultdict(lambda: defaultdict(list))
    for p in persons:
        rows_by_page[p["page"]][p["row"]].append(p)
    for pg in pages:
        for r, lst in sorted(rows_by_page[pg["page"]].items()):
            lst = sorted(lst, key=lambda x: x["col"])
            run = []
            for o in lst:
                if not run:
                    run = [o]
                elif o["col"] == run[-1]["col"] + 1:
                    run.append(o)
                else:
                    break
            if len(run) >= 2 and run[0]["col"] <= 2:
                spine_rows.append({"page": pg["page"], "row": r,
                                   "chain": [o["name"] for o in run],
                                   "oid": [o["oid"] for o in run]})
                for a, b in zip(run, run[1:]):
                    explicit_pairs.add((a["oid"], b["oid"]))
                if run[0]["col"] == 2:
                    head = [o for o in persons if o["page"] == pg["page"]
                            and o["col"] == 1 and o["row"] == r]
                    if head:
                        explicit_pairs.add((head[0]["oid"], run[0]["oid"]))

    # R2 配偶归属
    for sp in spouses:
        if sp.get("spouseOf"):
            continue
        c = [p for p in persons if p["page"] == sp["page"] and p["col"] == sp["col"]
             and p["row"] < sp["row"] and not p.get("unnamed")]
        sp["spouseOf"] = max(c, key=lambda p: p["row"])["oid"] if c else None

    # R3 注记归属
    #   原谱把旁注写在**被注人自己的列**或**其次代列（col+1）**，行号相同或相邻。
    #   旧实现按「行距优先」取最近者：D1710 的注记会被挂到同行的 I1710
    #   （跨 5 列、毫不相干），导致「为纾之四子过继」错挂在安裕身上。
    #   故改为**列优先**：同行且同列/上一代列 > 同列邻近行 > 上一代列邻近行 > 其余。
    def note_attach_key(p, nt):
        dcol = p["col"] - nt["col"]          # 被注人列 − 旁注列
        near = 0 if dcol in (0, -1) else 1   # 旁注写在本人列或其上一代列
        return (near, abs(p["row"] - nt["row"]), 0 if dcol == 0 else 1, abs(dcol))

    for nt in notes:
        c = [p for p in persons if p["page"] == nt["page"]]
        nt["attachTo"] = min(c, key=lambda p: note_attach_key(p, nt))["oid"] if c else None

    # R5 启发式父子：**粗块约束 + 块内取最近**。
    #
    #   ── 原谱正文区的排布规律 ─────────────────────────────────
    #   同一父的子女在下一世代列中**自上而下连续书写**；同一列上被**空行**
    #   隔开的连续区段，就是一个完整的「子女块」。原谱中一个父的子女不会
    #   被拆到两个块里，故**块内的子女必然同父**。
    #
    #   ── 逐人「行距最近」为什么会在块边界出错 ───────────────────
    #   它隐含假设「每位父都一定有子女」，于是按父行中点切分块边界。一旦
    #   某位父**无嗣**（原谱确实如此），其下方父的子女块就会「向上溢出」
    #   到他的行域内，被错误切走一块。第 5 页即典型案例：
    #     J 列 271–282 是一个完整子女块（世义…世元六人及其配偶），
    #     而「世义」J271 距怀裕 I269 仅 2 行、距庆裕 I276 有 5 行，
    #     遂被错挂到**无嗣**的怀裕名下。
    #   作者（孙智广）核对原谱确认：世义、曲莲花实归**庆裕**一支，怀裕无嗣。
    #
    #   ── 本规则 ──────────────────────────────────────────────
    #     1. 先把每个 (页, 列) 上被空行隔开的连续区段切为「粗块」；
    #     2. 子女只能分给**行号落在其所属粗块跨度内**的父——父若在块外，
    #        说明该父在此处无嗣，不参与竞争；
    #     3. 若块内没有任何父（子女块跨页延续，其父在上/下一页），
    #        回退为在该列全部父中取最近，保持与旧行为兼容；
    #     4. 候选内仍取 |Δ行| 最小者，并列时取行号较小者。
    #   实测：第 5 页世义→庆裕（作者核定一致）、第 7 页士学→繡（主干链一致）。
    #
    #   【失败方案留档】曾试过「块中位数单调 DP」（目标 Σ|块中位数−父行|）：
    #   该目标会奖励「把大块整体交给中点最近的父」，实测第 7 页把 D 列
    #   14 名子女**全部**判给「纹」（总代价 1.0），是灾难性的过合并，
    #   故弃用。Σ|子行−父行| 亦不可用：它倾向把边界个别子女「甩」给上一位
    #   父（第 5 页会得出「怀裕领 1 人」的错误折中解）。两条目标函数均已
    #   在 tools/compare_rules.py 中留档，可复现。
    #
    #   个案仍可由 AUTHOR_VERIFIED_PARENT（人工核定表）以更高证据级别订正。
    page_persons = defaultdict(list)
    for p in persons:
        page_persons[p["page"]].append(p)

    # 粗块：同一 (页, 列) 上的连续区段，**允许最多 2 个空行**（行差 ≤ 3）不断开。
    #   阈值不可取 1：原谱中子女会与父行对齐，父自己的格会占掉子女列的一行，
    #   于是同一父的相邻子女之间常见 1 行空档（如第 29 页 D1982 士芹、D1984 士祥，
    #   中间 D1983 空，因为父「嵩」占在 C1983）。若逢空行即断，嵩会被误判为
    #   「块外」而丢失子女。取 3 可容 2 行空档，同时仍能把第 5 页 J 列
    #   265–270 的 6 行大空档正确切开。
    #   配偶格同样占据行、决定块是否连续，故用 occs（人物 + 配偶）而非 persons 计算。
    BLOCK_GAP = 3
    block_id, block_span, bid = {}, {}, 0
    col_rows = defaultdict(list)
    for o in occs:
        col_rows[(o["page"], o["col"])].append(o["row"])
    for (pg, cl), rows in col_rows.items():
        prev = None
        for r in sorted(set(rows)):
            if prev is None or r - prev > BLOCK_GAP:
                bid += 1
            block_id[(pg, cl, r)] = bid
            sp = block_span.setdefault(bid, [r, r])
            sp[0], sp[1] = min(sp[0], r), max(sp[1], r)
            prev = r

    #   ── 最小干预原则（关键）──────────────────────────────────
    #   块约束**只用于否决「最近父落在块外」这一种情形**，其余一律维持
    #   「逐人行距最近」的原判。原因：块归属若全面替换逐人判定，会连带
    #   改动大量本无问题的挂接（实测 24 处父系漂移，其中跨页重复出现者
    #   因两页块划分不同而被误拆为两人）。而真正的错行只发生在「父在块外」
    #   时——父既已不在块内，说明该父在此处无嗣，其名额应让给块内的父。
    inferred, single_father_blocks, block_fallback = {}, [], 0
    for o in persons:
        if o["col"] <= 1:
            continue
        c = [x for x in page_persons[o["page"]]
             if x["col"] == o["col"] - 1 and not x.get("unnamed")]
        if not c:
            continue
        same = [x for x in c if x["row"] == o["row"]]
        if same:
            inferred[o["oid"]] = same[0]["oid"]
            continue
        c.sort(key=lambda x: (abs(x["row"] - o["row"]), 0 if x["row"] <= o["row"] else 1))
        best = c[0]
        blk = block_id.get((o["page"], o["col"], o["row"]))
        lo, hi = block_span.get(blk, (None, None))
        if lo is not None:
            inside = [x for x in c if lo <= x["row"] <= hi]
            if len(inside) == 1:
                # 块内只有一位父 ⇒ 该块子女必然全部归他，不存在「劈块」的可能
                if inside[0] is not best:
                    single_father_blocks.append({
                        "name": o["name"], "gen": o["gen"],
                        "page": o["page"], "ref": o["ref"],
                        "fromName": by_oid[best["oid"]]["name"],
                        "fromCell": by_oid[best["oid"]]["ref"],
                        "toName": by_oid[inside[0]["oid"]]["name"],
                        "toCell": by_oid[inside[0]["oid"]]["ref"],
                        "span": [lo, hi]})
                best = inside[0]
            elif not inside:
                block_fallback += 1      # 块内无父：子女块跨页延续，维持原判
        inferred[o["oid"]] = best["oid"]

    explicit_parent = {b: a for a, b in explicit_pairs}
    doc_forced = {}
    for pgen, pname, kids in DOC_EXPLICIT_CHAINS:
        ps = [p for p in persons if p["gen"] == pgen and p["name"] == pname and not p.get("unnamed")]
        for cgen, cname in kids:
            cs = [p for p in persons if p["gen"] == cgen and p["name"] == cname and not p.get("unnamed")]
            for c in cs:
                if ps:
                    doc_forced[c["oid"]] = ps[0]["oid"]

    # ── 人工核定表：按原谱单元格精确定位，级别高于 doc / spine / heuristic ──
    author_forced, author_notes = {}, []
    for page, cell, cname, cgen, fcell, fname, why in AUTHOR_VERIFIED_PARENT:
        kids = [p for p in persons if p["page"] == page and p["ref"] == cell]
        dads = [p for p in persons if p["page"] == page and p["ref"] == fcell]
        if not kids or not dads:
            author_notes.append(f"人工核定 {page}页{cell}→{fcell} 未命中单元格，已忽略")
            continue
        for k in kids:
            author_forced[k["oid"]] = dads[0]["oid"]
            author_notes.append(
                f"{page}页 {cell}「{k['name']}」父系由人工核定为 {fcell}「{dads[0]['name']}」（{why}）")

    parent_of, parent_ev = {}, {}
    for o in persons:
        if o["oid"] in author_forced:
            parent_of[o["oid"]], parent_ev[o["oid"]] = author_forced[o["oid"]], "author"
        elif o["oid"] in doc_forced:
            parent_of[o["oid"]], parent_ev[o["oid"]] = doc_forced[o["oid"]], "doc"
        elif o["oid"] in explicit_parent:
            parent_of[o["oid"]], parent_ev[o["oid"]] = explicit_parent[o["oid"]], "spine"
        elif o["oid"] in inferred:
            parent_of[o["oid"]], parent_ev[o["oid"]] = inferred[o["oid"]], "heuristic"

    name_of = lambda i: by_oid[i]["name"] if i in by_oid else None
    g1 = defaultdict(list)
    for p in persons:
        g1[(p["gen"], p["name"])].append(p)
    for lst in g1.values():
        pn = {name_of(parent_of[o["oid"]]) for o in lst if o["oid"] in parent_of}
        pn.discard(None)
        if len(pn) == 1:
            nm = pn.pop()
            for o in lst:
                if o["oid"] not in parent_of:
                    t = [x for x in lst if name_of(parent_of.get(x["oid"])) == nm]
                    if t:
                        parent_of[o["oid"]] = parent_of[t[0]["oid"]]
                        parent_ev[o["oid"]] = "heuristic"

    # ── R8 同名异人键：原谱已用「同名／重名」旁注显式区分 ──
    collision_keys = set()
    for nt in notes:
        if nt.get("noteType") == "name_collision" and nt.get("attachTo"):
            a = by_oid.get(nt["attachTo"])
            if a:
                collision_keys.add((a["gen"], a["name"]))

    # ── R9 过继旁注：原谱在该行记其生父，过继对象另立关系 ──
    adopt_row_parent = {}
    for nt in notes:
        if nt.get("noteType") == "adoption" and nt.get("attachTo") in parent_of:
            adopt_row_parent[nt["attachTo"]] = parent_of[nt["attachTo"]]

    # ── R9b 生父旁注：「为X之N子过继」「（X之N子过继）」「X之N子」 ──
    #   与「过继给Y为子」（指名**养父**）相对，此类旁注**指名生父**。
    #   原谱把出继子同时列于生父行与养父行：生父行常只余一句旁注，
    #   版式上「相邻世代列最近行」未必等于生父——如士仁 D435，最近者是「繡」，
    #   而旁注明言其为「纾之四子」（纾恰有士安/士和/士乐三子，士仁正是第四子）。
    #   故以**旁注指名**为准（evidence=note，等级最高），
    #   启发式误挂的父则退为养父（由既有过继关系另行表达），生父信息不再被静默丢弃。
    birth_father_of = {}          # 出现格 oid -> 生父 oid
    for nt in notes:
        if nt.get("noteType") != "birth_father" or not nt.get("attachTo"):
            continue
        child = by_oid.get(nt["attachTo"])
        nm = nt.get("birthFatherName")
        if not child or not nm:
            continue
        cands = [q for q in persons if q["name"] == nm and not q.get("unnamed")
                 and q["gen"] == child["gen"] - 1]
        if not cands:
            cands = [q for q in persons if q["name"] == nm and not q.get("unnamed")]
        if not cands:
            continue
        cands.sort(key=lambda q: (0 if q["page"] == nt["page"] else 1,
                                  abs(q["row"] - nt["row"]), abs(q["col"] - nt["col"])))
        birth_father_of[nt["attachTo"]] = cands[0]["oid"]

    for oid, foid in birth_father_of.items():
        parent_of[oid], parent_ev[oid] = foid, "note"

    # ── 人物身份键（递归、记忆化）──────────────────────────────
    #   一个「出现格」的人物身份 = (世代, 姓名, 父的人物身份)。
    #   父的世代恒为子 − 1（V002 保证世代跳跃为 0），故递归必然终止。
    #
    #   ★ 为什么分歧判定与实体归并必须共用同一个身份函数：
    #     旧实现的分歧判定比较的是**父的格子 oid**，而一个人在原谱中有多个出现格，
    #     于是「同一个父的多格」被误判为「父系分歧」，大量本应统一的组被推进拆分
    #     分支（V016 因而虚报 182 组）。此处统一用 pkey：父的多格归一到同一身份，
    #     真正的同名异父（如两个智广、三支来裕）才会判为分歧。
    _pkey_memo = {}

    def pkey(oid):
        k = _pkey_memo.get(oid)
        if k is not None:
            return k
        o = by_oid[oid]
        if o.get("unnamed"):
            k = ("unnamed", o["gen"], o["name"], o["page"], o["row"])
        else:
            par = parent_of.get(oid)
            k = (o["gen"], o["name"], pkey(par) if par is not None else None)
        _pkey_memo[oid] = k
        return k

    # ── R10 组内定父：证据强度 过继旁注(3) > 明载主干行(2) > 启发式(1) ──
    #   证据等级的含义：
    #     3 = 该行有「过继给X为子」旁注。旁注写在**生父所在行**，故该行的父即生父，
    #         且经旁注佐证，可信度最高。此时组内全部出现格统一采此生父；
    #         出继对象（养父）另立 adoption 关系，不占用 fatherId。
    #     2 = 原谱主干行显式记载（编谱者手绘的世系链）。
    #     1 = 按版式「相邻世代列最近行」推导。
    #
    #   为什么等级 3 必须能压过等级 2：过继子会同时出现在生父行与养父行——
    #   生父行带旁注，养父行是主干链。若让主干链胜出，fatherId 就会变成养父，
    #   生父信息被静默丢弃（言昌、士仁、缋等 15 例皆属此情形）。
    #
    #   若组内出现**多个不同的明载父系且均无旁注佐证**（等级同为 2），
    #   则保留各自父系、交由实体归并拆分为不同人物，并记入 V014 待人工复核，
    #   而不是强行归并、丢弃明载信息。
    #
    #   ★ 关键约束（2026-09 修正）：本谱采用「凡字」命名——同一世代的男丁共用
    #     一个字（如十二世皆含「世」、十一世皆含「裕」），故「同名 + 同世代」
    #     **远不等于**同一人。旧实现只按「组内最高等级」选一个父并统一全组，
    #     当组内各格自身父系分歧而等级相同时（典型：两个「智广」分别挂在不同
    #     父之下，等级同为 heuristic），会把两人的父强行统一成同一个，
    #     随后实体归并（key_of 含父名）便将两人合成一条记录，配偶与子女随之错配。
    #     修正：先判断组内各出现格**自身**父系是否分歧——
    #       · 未分歧（0 或 1 个不同父）→ 按证据等级统一（原逻辑）；
    #       · 已分歧 → 仅当存在**唯一**且等级**严格更高**的证据时统一
    #         （典型：过继旁注 rank3 压过主干链 rank2，使 fatherId = 生父）；
    #         否则**保留各自父系**，交由实体归并拆分为不同人物。
    RANK = {"author": 5, "note": 4, "doc": 3, "spine": 2, "heuristic": 1}
    group_conflicts = []
    same_name_splits = []          # 因父系分歧而放弃统一（同名异人，自动拆分）
    for (gen, name), lst in sorted(g1.items(), key=lambda kv: (kv[0][0], kv[0][1])):
        if (gen, name) in collision_keys:
            continue                      # 同名异人：逐次出现分别定父

        def rank_of(o):
            return 3 if o["oid"] in adopt_row_parent else RANK.get(parent_ev.get(o["oid"]), 0)

        def own_of(o):
            """该出现格**自身**的父（优先过继旁注）；未解析为 None。"""
            return adopt_row_parent.get(o["oid"]) or parent_of.get(o["oid"])

        own = {o["oid"]: own_of(o) for o in lst}
        # 分歧判定比较**父的人物身份**（pkey），而非父的格子——一个人有多格，
        # 按格子比较会把「同一父的多格」误判为分歧。
        distinct_own = {pkey(p) for p in own.values() if p is not None}

        if len(distinct_own) > 1:
            # 组内自身父系已分歧：先记录**明载**分歧，供 V014 人工复核
            explicit = {}
            for o in lst:
                if o["oid"] in parent_of and rank_of(o) >= 2:
                    explicit[parent_of[o["oid"]]] = name_of(parent_of[o["oid"]])
            distinct = {v for v in explicit.values() if v}
            conflict = None
            if len(distinct) > 1:
                conflict = {
                    "gen": gen, "name": name, "count": len(distinct),
                    "parents": sorted(distinct),
                    "cells": sorted(o["ref"] for o in lst if o["oid"] in parent_of),
                    "child_oids": [o["oid"] for o in lst],
                    "parent_oids": sorted(explicit.keys()),
                    "unified": False,
                }
                group_conflicts.append(conflict)

            # 唯一能「跨父系统一」的证据是**旁注**，且取等级最高者：
            #   rank4「为X之N子过继」——旁注**指名生父**，最硬；
            #   rank3「过继给Y为子」——旁注写在生父行，故该行的父即生父。
            # 过继子必然同时出现在生父行与养父行，两行给出的父天然不同，
            # 但那确实是同一个人；除旁注外，父系分歧一律视为同名异人。
            #
            # 特别注意：不能因为「主干链(2) 高于 启发式(1)」就统一 ——
            # 主干链只证明**该格**的父系，并不证明其他出现格属于同一人。
            # 实测：士达（綯之子 与 和之子）、滕（国铭之子 与 国坪之子）
            # 皆因此前的「等级压制」被误并。
            note_occs = [o for o in lst if rank_of(o) >= 3 and o["oid"] in parent_of]
            maxr = max((rank_of(o) for o in note_occs), default=0)
            top = [o for o in note_occs if rank_of(o) == maxr]
            top_parents = {parent_of[o["oid"]] for o in top}
            if maxr >= 3 and len(top_parents) == 1:
                wpid = top_parents.pop()
                woid = top[0]["oid"]
                for o in lst:
                    if rank_of(o) < maxr:
                        parent_of[o["oid"]] = wpid
                        parent_ev[o["oid"]] = parent_ev.get(woid, "heuristic")
                    _pkey_memo.pop(o["oid"], None)      # 父已变，身份键须重算
                if conflict is not None:
                    conflict["unified"] = True          # 分歧已由旁注（生父/过继）解释
                    conflict["unifiedBy"] = parent_ev.get(woid, "heuristic")
            else:
                # 无旁注解释 → 保留各自父系，由实体归并拆分
                same_name_splits.append({
                    "gen": gen, "name": name,
                    "parents": sorted({name_of(p) or "（未解析）"
                                       for p in own.values() if p is not None}),
                    "cells": sorted(o["ref"] for o in lst if own.get(o["oid"])),
                    "by": "父系分歧且无过继旁注",
                })
            continue

        # —— 组内父系一致：按证据等级统一（原逻辑） ——
        best = None
        for o in lst:
            pid = own.get(o["oid"])
            if pid is None:
                continue
            r = rank_of(o)
            if best is None or r > best[0]:
                best = (r, pid, o["oid"])
        if best is None:
            continue
        best_rank, best_pid, best_oid = best

        for o in lst:
            r = rank_of(o)
            if best_rank < 3 and r >= 2:
                # 组内无旁注佐证，且本格已有明载证据：保留本格，不强行统一
                continue
            parent_of[o["oid"]] = best_pid
            parent_ev[o["oid"]] = parent_ev.get(best_oid, "heuristic")

    # ── 实体归并（逐世代自顶向下）────────────────────────────
    #   分组键 = (世代, 姓名, 父的**人物身份**)。
    #
    #   为什么必须用「父的人物身份」而不是父**名**：
    #     本谱以凡字命名（同一世代共用一字），同名者极多；父也一样会重名。
    #     实测「来裕」在原谱中有三支不同的人（父分别为盛和 / 盛智 / 盛治）。
    #     若按父名分组，三支「来裕」各自的同名子会被并成同一人——
    #     这正是「两个智广被合并」之外的第二层同类错误。
    #
    #   为什么可以一次收敛而无需迭代：
    #     父的世代恒为子 − 1（V002 保证世代跳跃 0），故按世代**升序**处理时，
    #     归并某一世代时其父所在世代已归并完毕，父的人物 id 已确定。
    by_gen = defaultdict(list)
    for p in persons:
        by_gen[p["gen"]].append(p)

    def key_of(p):
        if p.get("unnamed"):
            return ("unnamed", p["gen"], p["name"], p["page"], p["row"])
        fid = person_id.get(parent_of.get(p["oid"]))
        # 父已归并 → 直接用其人物 id；否则（父未解析/异常）退回父名，保持原行为
        fkey = fid or ("name:" + (name_of(parent_of.get(p["oid"])) or ""))
        return (p["gen"], p["name"], fkey)

    person_id, merged = {}, []
    for gen in sorted(by_gen):
        groups = defaultdict(list)
        for p in by_gen[gen]:
            groups[key_of(p)].append(p)
        ordered = sorted(groups.items(),
                         key=lambda kv: (min(o["page"] * 10000 + o["row"] for o in kv[1]),
                                         kv[1][0]["name"]))
        for k, lst in ordered:
            pid = f"P{len(merged) + 1:04d}"
            for o in lst:
                person_id[o["oid"]] = pid
            head = lst[0]
            merged.append({"id": pid, "gen": head["gen"], "name": head["name"],
                           "unnamed": bool(head.get("unnamed")),
                           "pinyin": next((o["pinyin"] for o in lst if o.get("pinyin")), None),
                           "occurrences": lst})

    pid_parent, pid_ev = {}, {}
    for m in merged:
        pp = Counter(person_id.get(parent_of.get(o["oid"])) for o in m["occurrences"])
        pp.pop(None, None)
        pid_parent[m["id"]] = pp.most_common(1)[0][0] if pp else None
        ev = Counter(parent_ev.get(o["oid"]) for o in m["occurrences"])
        ev.pop(None, None)
        pid_ev[m["id"]] = ev.most_common(1)[0][0] if ev else None

    # 配偶归并
    sp_groups = defaultdict(list)
    for sp in spouses:
        owner = person_id.get(sp["spouseOf"]) if sp["spouseOf"] else None
        sp_groups[(owner, sp["display"])].append(sp)
    spouse_records, spouse_id = [], {}
    for n, ((owner, display), lst) in enumerate(sorted(
            sp_groups.items(), key=lambda kv: (str(kv[0][0]), kv[0][1])), 1):
        sid = f"S{n:04d}"
        for sp in lst:
            spouse_id[sp["oid"]] = sid
        spouse_records.append({"id": sid, "surname": lst[0]["surname"], "spouseOf": owner,
                               "name": display, "named": lst[0].get("named", False),
                               "givenName": lst[0].get("givenName"),
                               "gen": lst[0]["gen"], "occurrences": lst})

    # R7 支系
    branch = {}
    for m in merged:
        if m["gen"] == 1:
            branch[m["id"]] = "始祖"
        elif m["gen"] == 3 and m["name"] in BRANCH_HEADS:
            branch[m["id"]] = m["name"]
    for _ in range(40):
        ch = False
        for m in merged:
            if m["id"] not in branch and pid_parent.get(m["id"]) in branch:
                branch[m["id"]] = branch[pid_parent[m["id"]]]
                ch = True
        if not ch:
            break
    # 兜底：按页内 col-1 支系头
    page_head = {}
    for pg in pages:
        hs = {p["name"] for p in persons if p["page"] == pg["page"] and p["col"] == 1
              and p["name"] in BRANCH_HEADS}
        if hs:
            page_head[pg["page"]] = hs.pop()
    for m in merged:
        if m["id"] not in branch:
            c = Counter(page_head.get(o["page"]) for o in m["occurrences"])
            c.pop(None, None)
            branch[m["id"]] = c.most_common(1)[0][0] if c else "未定"
    for sr in spouse_records:
        sr["branch"] = branch.get(sr["spouseOf"], "未定") if sr["spouseOf"] else "未定"

    return dict(pages=pages, persons=persons, spouses=spouses, notes=notes,
                merged=merged, spouse_records=spouse_records, person_id=person_id,
                spouse_id=spouse_id, parent_of=parent_of, parent_ev=parent_ev,
                pid_parent=pid_parent, pid_ev=pid_ev, spine_rows=spine_rows,
                branch=branch, page_head=page_head, by_oid=by_oid,
                group_conflicts=group_conflicts, same_name_splits=same_name_splits,
                single_father_blocks=single_father_blocks,
                block_fallback=block_fallback)


if __name__ == "__main__":
    import hashlib

    d = build()
    merged, spouse_records = d["merged"], d["spouse_records"]
    branch, pid_parent, pid_ev = d["branch"], d["pid_parent"], d["pid_ev"]

    # ── 组装人物 ────────────────────────────────────────────
    persons, children_map = [], defaultdict(list)
    for m in merged:
        children_map[pid_parent.get(m["id"])].append(m["id"])

    note_by_person = defaultdict(list)
    for nt in d["notes"]:
        if nt.get("attachTo"):
            pid = d["person_id"].get(nt["attachTo"])
            if pid:
                note_by_person[pid].append(nt)

    spouse_by_owner = defaultdict(list)
    for sr in spouse_records:
        if sr["spouseOf"]:
            spouse_by_owner[sr["spouseOf"]].append(sr["id"])

    def refs_of(occs):
        return [{"page": o["page"], "row": o["row"], "col": o["col"],
                 "cell": o["ref"], "raw": o["raw"]} for o in occs]

    def note_obj(n):
        """旁注对象。除文本与归类外，保留原谱单元格坐标，使旁注亦可逐格回溯。"""
        return {"type": n.get("noteType") or "status", "text": n["raw"],
                "targetPage": n.get("targetPage"),
                "page": n.get("page"), "row": n.get("row"), "col": n.get("col"),
                "cell": n.get("ref")}

    for m in merged:
        b = branch.get(m["id"], "未定")
        status = "normal"
        nt_list = note_by_person.get(m["id"], [])
        for nt in nt_list:
            if nt.get("status"):
                status = nt["status"]
        persons.append({
            "id": m["id"], "name": m["name"], "surname": "孙",
            "fullName": m["name"] if m["name"].startswith("孙") else "孙" + m["name"],
            "gender": "M", "isSpouse": False, "unnamed": m["unnamed"],
            "gen": m["gen"], "genLabel": GEN_LABEL.get(m["gen"], f"{m['gen']}世"),
            "genChar": GEN_CHAR_MAP.get(m["gen"]),
            "genCharPosition": GEN_CHAR_POS.get(m["gen"]),
            "branchId": BRANCH_META.get(b, ("BR-UNDEF",))[0], "branchKey": b,
            "status": status, "pinyin": m["pinyin"],
            "fatherId": pid_parent.get(m["id"]), "motherId": None,
            "spouseIds": spouse_by_owner.get(m["id"], []),
            "childrenIds": children_map.get(m["id"], []),
            "parentEvidence": pid_ev.get(m["id"]),
            "notes": [note_obj(n) for n in nt_list],
            "refs": refs_of(m["occurrences"]),
            "confidence": {"parent": {"author": "author-verified", "doc": "explicit",
                                      "spine": "explicit", "note": "explicit",
                                      "heuristic": "inferred"}.get(pid_ev.get(m["id"]), "unknown")},
        })
    for sr in spouse_records:
        b = sr.get("branch", "未定")
        nt_list = note_by_person.get(sr["id"], [])
        persons.append({
            "id": sr["id"], "name": sr["name"], "surname": sr["surname"] or None,
            "givenName": sr.get("givenName"), "namedSpouse": sr.get("named", False),
            "fullName": sr["name"], "gender": "F", "isSpouse": True, "unnamed": False,
            "gen": sr["gen"], "genLabel": GEN_LABEL.get(sr["gen"], f"{sr['gen']}世"),
            "genChar": None, "genCharPosition": None,
            "branchId": BRANCH_META.get(b, ("BR-UNDEF",))[0], "branchKey": b,
            "status": "normal", "pinyin": None,
            "fatherId": None, "motherId": None,
            # 配偶不变量：spouseIds 恒为「本人的配偶（下向）」，配偶自身的配偶列表为空，
            # 其夫主一律由 spouseOfId 表达。二者互斥，避免同一关系被双向重复表达。
            "spouseIds": [], "childrenIds": [], "spouseOfId": sr["spouseOf"], "parentEvidence": None,
            "notes": [note_obj(n) for n in nt_list],
            "refs": refs_of(sr["occurrences"]), "confidence": {"parent": "n/a"},
        })

    by_id = {p["id"]: p for p in persons}
    for p in persons:
        if p["isSpouse"] and p.get("spouseOfId"):
            owner = by_id.get(p["spouseOfId"])
            if owner and p["id"] not in owner["spouseIds"]:
                owner["spouseIds"].append(p["id"])

    # ── 旁注索引（含原谱单元格坐标） ────────────────────────
    #   目的：使旁注与人物一样可逐格回溯，并让"单元格全覆盖"成为可校验的不变量。
    note_index = []
    for nt in d["notes"]:
        oid = nt.get("attachTo")
        pid = (d["person_id"].get(oid) or d["spouse_id"].get(oid)) if oid else None
        note_index.append({
            "page": nt["page"], "row": nt["row"], "col": nt["col"], "cell": nt["ref"],
            "text": nt["raw"], "type": nt.get("noteType") or "status",
            "targetPage": nt.get("targetPage"), "attachedToId": pid,
        })
    note_index.sort(key=lambda x: (x["page"], x["row"], x["col"]))

    # ── 关系 ────────────────────────────────────────────────
    relations = []
    rid = [0]

    def add_rel(t, a, b, ev, conf, note=""):
        rid[0] += 1
        relations.append({"id": f"R{rid[0]:05d}", "type": t, "fromId": a, "toId": b,
                          "evidence": ev, "confidence": conf, "note": note})

    for p in persons:
        if p["fatherId"] and p["fatherId"] in by_id:
            add_rel("parent-child", p["fatherId"], p["id"], p["parentEvidence"] or "heuristic",
                    p["confidence"]["parent"])
    for p in persons:
        if p["isSpouse"] and p.get("spouseOfId") and p["spouseOfId"] in by_id:
            add_rel("spouse", p["spouseOfId"], p["id"], "adjacency", "explicit")

    # 过继关系：旁注「过继给X为子」记在生父行，X 为养父（出继对象）。
    # 解析要点：
    #   · 原谱可能写作「过继给孙恒为子」，其中「孙」为冠姓，需剥离后匹配；
    #   · 养父应为父辈（gen − 1），据此在重名者中择优；
    #   · 无法定位养父者记入 V015 待考，不猜测。
    #   去重要点：同一「出继 → 养父」关系在原件中可能重复出现多次
    #   （出继子同时见于生父行与养父行，跨页亦会重复），而一条过继关系只能记一次。
    #   故以 (出继子, 养父) 为键去重；被折叠掉的重复次数另行统计，供追溯。
    adoption_rels = 0
    adopt_unresolved = []
    adopt_seen = {}
    for p in persons:
        for nt in p["notes"]:
            if nt["type"] != "adoption":
                continue
            m = ADOPT_OUT_RE.match(nt["text"])
            if not m:
                continue
            raw_name = m.group(1)
            stripped = raw_name[1:] if (raw_name.startswith("孙") and len(raw_name) > 1) else raw_name
            cands = [q for q in persons if q["name"] == stripped and not q["isSpouse"]]
            if not cands:
                cands = [q for q in persons if q["name"] == raw_name and not q["isSpouse"]]
            seniors = [q for q in cands if q["gen"] == p["gen"] - 1]
            if seniors:
                cands = seniors
            # 养父定位：同名者可能不止一个（五世有两处「恒」：C1626 与 C1714/C1786）。
            # 「过继给X为子」的旁注写在出继子格旁，故养父必是**与出继子同行相邻**
            # 的那一个（主干链上紧邻其右）。据此在同名候选中优先取「与本人任一出现格
            # 同行」者，其次「同页」，最后才按默认顺序——否则会挂到另一位同名的
            # 「恒」上，使主干链「恒 → 士仁」在独立校验（C05）中判为断裂。
            p_rows = {(r["page"], r["row"]) for r in p.get("refs", [])}
            p_pages = {r["page"] for r in p.get("refs", [])}

            def _loc(q):
                refs = q.get("refs", [])
                if any((rr["page"], rr["row"]) in p_rows for rr in refs):
                    return 0
                if any(rr["page"] in p_pages for rr in refs):
                    return 1
                return 2

            cands.sort(key=_loc)
            if cands:
                key = (p["id"], cands[0]["id"])
                if key in adopt_seen:
                    adopt_seen[key]["dupes"] += 1
                    continue
                adopt_seen[key] = {"dupes": 0}
                add_rel("adoption", p["id"], cands[0]["id"], "note", "explicit", nt["text"])
                adoption_rels += 1
            else:
                adopt_unresolved.append({"id": p["id"], "name": p["name"], "gen": p["gen"],
                                         "genLabel": p["genLabel"], "branch": p["branchKey"],
                                         "refs": [nt.get("cell") or "-"],
                                         "detail": f"旁注「{nt['text']}」所指养父「{raw_name}」未能定位"})

    # ── 校验 ────────────────────────────────────────────────
    issues = []

    def issue(code, severity, title, detail, items):
        issues.append({"code": code, "severity": severity, "title": title,
                       "detail": detail, "count": len(items), "items": items[:200]})

    def pi(p, extra=""):
        return {"id": p["id"], "name": p["name"], "gen": p["gen"],
                "genLabel": p["genLabel"], "branch": p["branchKey"],
                "refs": [r["cell"] for r in p["refs"][:3]], "detail": extra}

    # V001 世代越界
    issue("V001", "error", "世代越界",
          "世代序号必须落在 1–18 之间（图表第1页为一代，其余页为三代至十八代）。",
          [pi(p, f"世代={p['gen']}") for p in persons if not (1 <= p["gen"] <= 18)])

    # V002 世代跳跃
    bad = [p for p in persons if p["fatherId"] and p["fatherId"] in by_id
           and by_id[p["fatherId"]]["gen"] + 1 != p["gen"]]
    issue("V002", "error", "世代跳跃（父世代 +1 ≠ 子世代）",
          "父子关系要求子世代 = 父世代 + 1；不满足者多为启发式推导的误挂。",
          [pi(p, f"父 {by_id[p['fatherId']]['name']}({by_id[p['fatherId']]['genLabel']}) → 子({p['genLabel']})")
           for p in bad])

    # V003 支系不一致
    bad = [p for p in persons if p["fatherId"] and p["fatherId"] in by_id
           and by_id[p["fatherId"]]["branchKey"] != p["branchKey"]]
    issue("V003", "warn", "支系不一致（子支系 ≠ 父支系）",
          "同一父系应归属同一支系。",
          [pi(p, f"父支系 {by_id[p['fatherId']]['branchKey']} ≠ 子支系 {p['branchKey']}") for p in bad])

    # V004 无父
    bad = [p for p in persons if not p["isSpouse"] and p["gen"] > 1
           and not p["fatherId"] and p["name"] not in BRANCH_HEADS]
    issue("V004", "warn", "世系断点（无父可考）",
          "非支系头、非一世祖的人物未挂接到父辈，需人工考证后补录。", [pi(p) for p in bad])

    # V005 同名同世不同父
    g = defaultdict(list)
    for p in persons:
        if not p["isSpouse"]:
            g[(p["gen"], p["name"])].append(p)
    bad = []
    for (gen, nm), lst in g.items():
        if len(lst) > 1:
            bad.append({"id": ",".join(x["id"] for x in lst), "name": nm, "gen": gen,
                        "genLabel": GEN_LABEL.get(gen), "branch": lst[0]["branchKey"],
                        "refs": [r["cell"] for r in lst[0]["refs"][:3]],
                        "detail": "同世代同名共 %d 人，分属不同父系" % len(lst)})
    issue("V005", "info", "同世代同名（同名异人）",
          "原谱已用「与某之X子同名/重名」标注此类情况，系统保留为独立人物。", bad)

    # V006 配偶未关联
    issue("V006", "error", "配偶未关联夫主",
          "「X氏」单元格未能定位其夫主，无法建立婚姻关系。",
          [pi(p) for p in persons if p["isSpouse"] and not p.get("spouseOfId")])

    # V007 标注未解析
    bad = [n for n in d["notes"] if n.get("noteType") == "unparsed"]
    issue("V007", "warn", "旁注未能归类",
          "原谱旁注未匹配到既有标注类型，已原文保留。",
          [{"id": "-", "name": n["raw"], "gen": n["gen"], "genLabel": GEN_LABEL.get(n["gen"]),
            "branch": "-", "refs": [n["ref"]], "detail": f"第{n['page']}页 {n['ref']}"} for n in bad])

    # V008 凡字不符
    bad = []
    for p in persons:
        if p["isSpouse"] or p["unnamed"] or p["gen"] not in GEN_CHAR_MAP:
            continue
        ch = GEN_CHAR_MAP[p["gen"]]
        if ch not in p["name"]:
            bad.append(pi(p, f"第{p['genLabel']}凡字应为「{ch}」（{GEN_CHAR_POS[p['gen']]}），名中未见"))
    issue("V008", "warn", "辈分字（凡字）不符",
          "《前言》定「士昌道德盛 裕世广大年 / 学成保国志 良善福寿全」二十辈凡字；名中应含本辈凡字。",
          bad)

    # V009 启发式与显式冲突
    conflict = []
    for p in persons:
        if not p["fatherId"] or p["parentEvidence"] != "heuristic":
            continue
        oids = [o["oid"] for o in d["by_oid"].values() if False]
        conflict.append(p)
    issue("V009", "info", "启发式挂接（待人工复核）",
          "父子关系由「相邻世代列最近行距」启发式推导，未经原谱明载确认，建议逐条复核。",
          [pi(p) for p in conflict])

    # V010 少亡/无后却有子女
    bad = [p for p in persons if p["status"] in ("少亡", "无后") and p["childrenIds"]]
    issue("V010", "warn", "状态与子嗣矛盾",
          "标注为「少亡」「无后」者不应有子女记录。",
          [pi(p, f"状态={p['status']}，子女数={len(p['childrenIds'])}") for p in bad])

    # V011 未具名
    bad = [p for p in persons if p["unnamed"]]
    issue("V011", "info", "未具名人物（乳名/排行占位）",
          "原谱以「二子」「财子」等乳名或排行占位，暂无正式谱名。", [pi(p) for p in bad])

    # V012 支系未定
    bad = [p for p in persons if p["branchKey"] == "未定"]
    issue("V012", "error", "支系未定",
          "无法归属到六大支系之一。", [pi(p) for p in bad])

    # V013 未循凡字命名（疑似女性未识出）
    bad = [p for p in persons if not p["isSpouse"] and p["gen"] in GEN_CHAR_MAP
           and not p["unnamed"] and GEN_CHAR_MAP[p["gen"]] not in p["name"]]
    issue("V013", "warn", "未循辈分字命名（性别待考）",
          "第6–15世男性应含本辈凡字。此类单元格无凡字且其上方同列无男性可依附，"
          "可能是未循凡字命名者，也可能是原谱女性未以「氏」记名，需人工确认性别。",
          [pi(p, f"第{p['genLabel']}凡字应为「{GEN_CHAR_MAP[p['gen']]}」") for p in bad])

    # V014 同名同世而明载父系相异（疑似原谱未标注的同名异人）
    #   先剔除「已由过继关系解释」的情形：过继子会同时出现在生父行与养父行，
    #   两行给出的父不同属正常——生父入 fatherId，养父入 adoption 关系。
    #   只有当某个分歧父既非生父、也非出继对象时，才是真正无法解释的冲突。
    adopt_pairs = {(r["fromId"], r["toId"]) for r in relations if r["type"] == "adoption"}
    unexplained = []
    explained_by_adoption = 0
    for c in d.get("group_conflicts", []):
        if c.get("unified"):
            explained_by_adoption += 1        # 已由旁注（生父/过继）统一，无残留冲突
            continue
        cids = {d["person_id"].get(x) for x in c.get("child_oids", [])}
        cids.discard(None)
        pids = {d["person_id"].get(x) for x in c.get("parent_oids", [])}
        pids.discard(None)
        if not cids or not pids:
            continue
        missing = [p for p in pids
                   if not any(by_id.get(ci, {}).get("fatherId") == p or (ci, p) in adopt_pairs
                              for ci in cids)]
        if not missing:
            explained_by_adoption += 1
            continue
        unexplained.append({
            "id": "-", "name": c["name"], "gen": c["gen"], "genLabel": GEN_LABEL.get(c["gen"]),
            "branch": "-", "refs": c["cells"][:3],
            "detail": f"分别挂于 {'、'.join(c['parents'])} 之下，其中 "
                      f"{'、'.join(by_id[p]['name'] for p in missing)} 既非生父亦非出继对象",
        })
    issue("V014", "info", "同名同世而明载父系相异（无法由过继解释）",
          "同一世代、同一姓名，在原谱主干行中分别挂于不同的父之下，且该差异**不能**由"
          "「过继给X为子」旁注解释。原谱对已识别的同名异人多有「与某之X子同名」旁注"
          "（已按 R8 单独处理）；此列表为**未见旁注**者，系统按各自的明载父系保留为"
          "不同人物，请人工确认究竟是同名异人，还是原谱笔误。",
          unexplained)
    if explained_by_adoption:
        print(f"  (V014 提示：另有 {explained_by_adoption} 组明载父系差异已由过继关系解释，不计入冲突)")

    # V015 过继旁注所指养父未能定位
    issue("V015", "warn", "过继关系未能建立",
          "旁注「过继给X为子」已识别，但 X 未能在同世代减一的父辈中定位到唯一人物，"
          "该过继关系暂缺，需人工指定。",
          adopt_unresolved)

    # V016 同名同世、出现格各自父系分歧（已自动拆分为不同人物）
    #   本谱以凡字命名，同世代同名者众。同一姓名若在不同页面/不同父之下出现，
    #   且该分歧**不能**由过继旁注解释，则按「不同人」处理，各自保留父系。
    #   此处列出全部自动拆分，供人工抽查——尤其是同支系内的拆分。
    splits = d.get("same_name_splits", [])
    issue("V016", "info", "同名同世而异父（已自动拆分）",
          "同一世代、同一姓名的出现格分别挂于不同的父之下，且无过继旁注可解释。"
          "系统按「同名异人」处理：保留各自父系，拆分为**不同人物**，"
          "以免配偶与子女被错误地并入同一条记录。"
          "请抽查确认——尤其是同一支系内的拆分，是否确为两人。",
          [{"id": "-", "name": x["name"], "gen": x["gen"],
            "genLabel": GEN_LABEL.get(x["gen"]), "branch": "-",
            "refs": x["cells"][:4],
            "detail": "分别挂于 %s 之下（%s）" % ("、".join(x["parents"]), x["by"])}
           for x in splits])

    # V017 单一父块修正（块边界劈块已纠正）
    #   原谱中一位父的子女连续书写；同一 (页, 列) 上被空行隔开的连续区段即
    #   「粗块」。若块内**只有一位父**，该块子女必然全部归他。逐人「行距最近」
    #   会在块边界把子女劈给块外的相邻父——第 5 页世义 J271 被判给块外的
    #   怀裕 I269 即此（怀裕无嗣，其名额被逐人规则误用）。
    #   本项列出全部被「块内唯一父」纠正的挂接，供审计与回归比对：
    #   若某次改动使该列表异常增减，说明块约束失效，应立即排查。
    issue("V017", "info", "单一父块修正（块边界劈块已纠正）",
          "某子女所在的连续区段内只有一位父，但逐人「行距最近」把它判给了"
          "区段之外的父（典型：无嗣的父会「吸走」下方父的首名子女）。"
          "系统按「块内唯一父」纠正。列出全部纠正，供审计与回归比对："
          "若某次改动使该列表异常增减，说明块约束失效，应立即排查。",
          [{"id": "-", "name": x["name"], "gen": x["gen"],
            "genLabel": GEN_LABEL.get(x["gen"]), "branch": "-",
            "refs": [{"page": x["page"], "row": x["ref"].split(":")[-1] if ":" in x["ref"] else None,
                      "cell": x["ref"], "raw": x["name"]}],
            "detail": "第%d页 %s：由 %s(%s，块外) 改判为 %s(%s，块内唯一父，块 %d–%d)"
                      % (x["page"], x["ref"], x["fromName"], x["fromCell"],
                         x["toName"], x["toCell"], x["span"][0], x["span"][1])}
           for x in d["single_father_blocks"]])

    # V018 无「为」字的过继旁注（原谱只余旁注、其人失名）
    #   如「道和长子过继」「道恕过继」：指名生父，却不指名被注人。
    #   此类格**不得**当作人名（旧实现会凭空生成假人），故归为惰性旁注，
    #   仅留档待考；列出以便作者按原谱补出被注人姓名后转为正式记录。
    bad = [n for n in d["notes"] if n.get("noteType") == "adoption_ref"]
    issue("V018", "warn", "过继旁注未指名被注人（原谱其人失名）",
          "原谱此处只余一句过继旁注（如「道和长子过继」），指其生父却未记其名，"
          "故无法立为人物记录。已原文保留为旁注，待作者按原谱补名。",
          [{"id": "-", "name": n["raw"], "gen": n["gen"], "genLabel": GEN_LABEL.get(n["gen"]),
            "branch": "-", "refs": [n["ref"]],
            "detail": "第%d页 %s：生父或为「%s」" % (n["page"], n["ref"], n.get("refName") or "?")}
           for n in bad])

    # V019 空巢父（有配偶而无子女，紧邻下一位父却有 ≥2 子女）——待考清单
    #   此类是「错行」的**残余风险信号**：若某父的子女被下方父错收，他便成了
    #   空巢。与诊断脚本 diagnose_alignment.py 的 A 类同源，此处固化为构建期
    #   规则，使任何改动导致的**新增空巢**都会在报告里显形（防同类问题复现）。
    #   注意排除过继：出继子按原谱惯例列于**养父行位**，故「名下有养子者」
    #   与「子女为出继子者」都不算空巢，否则会把正常过继误报（实测假阳性 3 处）。
    _adoptees = {r["fromId"] for r in relations if r["type"] == "adoption"}
    _adoptees |= {n["attachedToId"] for n in d["notes"]
                  if n.get("type") in ("adoption", "birth_father") and n.get("attachedToId")}
    _adoptive = {r["toId"] for r in relations if r["type"] == "adoption"}
    _kids = defaultdict(list)
    for p in persons:
        if p.get("fatherId"):
            _kids[p["fatherId"]].append(p)

    def _onpage(p, pg):
        return any(r["page"] == pg for r in p.get("refs", []))

    def _kids_onpage(pid, pg):
        return [c for c in _kids.get(pid, []) if _onpage(c, pg)]

    def _real_kids(pid, pg):
        return [c for c in _kids_onpage(pid, pg) if c["id"] not in _adoptees]

    _rows = defaultdict(list)
    for p in persons:
        if p["isSpouse"] or p.get("unnamed"):
            continue
        seen_pages = set()
        for r in p.get("refs", []):
            if r["page"] in seen_pages:       # 同页多格只计一次，避免自比
                continue
            seen_pages.add(r["page"])
            _rows[(r["page"], p["gen"])].append((r["row"], p))
    _nest = []
    for (pg, gen), lst in _rows.items():
        lst.sort(key=lambda t: t[0])
        for i, (row, f) in enumerate(lst):
            if not f.get("spouseIds") or f["id"] in _adoptive:
                continue
            # 只要其行下有子女出现格（含出继子），即非空巢
            if _kids_onpage(f["id"], pg):
                continue
            if i + 1 >= len(lst):
                continue
            nrow, nf = lst[i + 1]
            nk = _real_kids(nf["id"], pg)
            if len(nk) >= 2:
                _nest.append((f, row, pg, gen, nf, nrow, len(nk)))
    _nest.sort(key=lambda t: (t[2], t[3], t[1]))
    issue("V019", "info", "空巢父（有配偶无子女，待考）",
          "某父有配偶却名下无子女（生父子女与过继子俱无），而同列紧邻的下一位父"
          "却有 ≥2 名子女。多数系原谱本就未记其子嗣（少亡、失载），"
          "但亦可能其子女被下方父错收——故列为**待考**，请按原谱复核。",
          [{"id": f["id"], "name": f["name"], "gen": gen, "genLabel": GEN_LABEL.get(gen),
            "branch": f.get("branchKey"), "refs": f.get("refs", [])[:1],
            "detail": "第%d页 %s「%s」(行%d) 有配偶无子女；紧邻下一位 %s「%s」(行%d) 却有 %d 名子女"
                      % (pg, f["refs"][0]["cell"] if f.get("refs") else "-",
                         f["name"], row, nf["refs"][0]["cell"] if nf.get("refs") else "-",
                         nf["name"], nrow, nkids)}
           for (f, row, pg, gen, nf, nrow, nkids) in _nest])

    # ── 元数据 ──────────────────────────────────────────────
    src_manifest = []
    for f in ["chart-raw.json", "doc-text.json"]:
        fp = SRC / f
        if fp.exists():
            src_manifest.append({"file": f, "bytes": fp.stat().st_size,
                                 "sha256": hashlib.sha256(fp.read_bytes()).hexdigest()})
    for orig in [Path(r"D:\book\cert pic\孙氏族谱.xlsx"), Path(r"D:\book\cert pic\孙氏族谱1.doc")]:
        if orig.exists():
            src_manifest.append({"file": str(orig), "bytes": orig.stat().st_size,
                                 "sha256": hashlib.sha256(orig.read_bytes()).hexdigest()})

    gen_rows = []
    for gg in range(1, 19):
        cnt = sum(1 for p in persons if p["gen"] == gg and not p["isSpouse"])
        gen_rows.append({"gen": gg, "label": GEN_LABEL[gg], "char": GEN_CHAR_MAP.get(gg),
                         "position": GEN_CHAR_POS.get(gg), "personCount": cnt})

    branches = []
    for k, (bid, bname, bdesc) in BRANCH_META.items():
        members = [p for p in persons if p["branchKey"] == k and not p["isSpouse"]]
        head = next((p["id"] for p in persons if p["gen"] == 3 and p["name"] == k and not p["isSpouse"]), None)
        branches.append({"id": bid, "key": k, "name": bname, "description": bdesc,
                         "headPersonId": head, "personCount": len(members),
                         "minGen": min([p["gen"] for p in members], default=None),
                         "maxGen": max([p["gen"] for p in members], default=None)})

    stats = {
        "personTotal": len(persons),
        "maleTotal": sum(1 for p in persons if not p["isSpouse"]),
        "spouseTotal": sum(1 for p in persons if p["isSpouse"]),
        "relationTotal": len(relations),
        "parentChildRelations": sum(1 for r in relations if r["type"] == "parent-child"),
        "spouseRelations": sum(1 for r in relations if r["type"] == "spouse"),
        "adoptionRelations": adoption_rels,
        "maxGeneration": max(p["gen"] for p in persons),
        "pages": len(d["pages"]),
        "sourceCells": 2779,
        "noteTotal": len(note_index),
        "explicitParentLinks": sum(1 for p in persons if p["confidence"]["parent"] == "explicit"),
        "inferredParentLinks": sum(1 for p in persons if p["confidence"]["parent"] == "inferred"),
        "issueTotal": sum(i["count"] for i in issues),
        "errorTotal": sum(i["count"] for i in issues if i["severity"] == "error"),
    }

    now = datetime.now(CST).isoformat(timespec="seconds")
    genealogy = {
        "meta": {
            "title": "孙氏族谱", "subtitle": "静态族谱站点",
            "version": "1.0.0", "schemaVersion": "1.0.0",
            "generatedAt": now,
            "generator": "tools/build_data.py",
            "sourceManifest": src_manifest,
            "disclaimer": "本数据集由《孙氏族谱.xlsx》世系图表与《孙氏族谱1.doc》文献自动转录并结构化；"
                          "标记为 inferred 的父子关系为启发式推导，须经人工复核方可视为定论。",
        },
        "generations": gen_rows,
        "branches": branches,
        "persons": persons,
        "notes": note_index,
        "relations": relations,
    }

    report = {"generatedAt": now, "totals": stats,
              "severityOrder": ["error", "warn", "info"], "issues": issues}

    (ROOT / "data").mkdir(exist_ok=True)
    (ROOT / "data" / "genealogy.json").write_text(
        json.dumps(genealogy, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (ROOT / "data" / "validation-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")

    # ── intro.json ──────────────────────────────────────────
    doc = json.loads((SRC / "doc-text.json").read_text(encoding="utf-8"))
    P = [x.replace("\u2408", "").strip() for x in doc["paragraphs"]]

    def pick(idxs):
        return [P[i] for i in idxs if 0 <= i < len(P) and P[i]]

    toc_raw = P[34] if len(P) > 34 else ""
    toc_items = [x for x in toc_raw.split("\u241e") if x]
    intro = {
        "meta": {"source": doc["source"], "paragraphCount": doc["paragraphCount"],
                 "charCount": doc["charCount"], "extractedAt": now,
                 "sha256": next((s["sha256"] for s in src_manifest if s["file"] == "doc-text.json"), None)},
        "cover": {"title": "孙氏族谱", "date": "二零二二年五月",
                  "editors": ["九世孙 孙金德（敬辑并书）", "九世孙 孙性德（续编打印）",
                              "十一世孙 孙樟裕（校订／电子化）"]},
        "sections": [
            {"id": "COLOPHON", "title": "版本沿革", "kind": "prose",
             "paragraphs": pick([21])},
            {"id": "TOC", "title": "目录", "kind": "toc",
             "raw": toc_raw, "items": toc_items},
            # 前言以「原籍 / 文友公流落三道嘴子」开篇（原谱 P35），
            # 再叙「文友公与岛外北滩亮子屯曲姓女」结亲（原谱 P36）。
            # 原实现漏收 P35，导致开篇第一段缺失，此处一并补回并置于最前。
            {"id": "PREFACE", "title": "孙氏族谱前言", "kind": "prose",
             "paragraphs": pick([35, 36, 37, 38, 39, 40, 41, 42]),
             "signature": pick([44, 45])},
            {"id": "GEN_CHARS", "title": "凡字（辈分字）与注记", "kind": "prose",
             "paragraphs": pick([46, 47, 49, 50, 51, 52, 53, 54]),
             "signature": pick([56, 57])},
            {"id": "NONGKEN", "title": "当代中国的农垦（辽宁部分）", "kind": "prose",
             "paragraphs": pick([62]), "notes": pick([64]), "signature": pick([66, 67])},
            {"id": "POSTSCRIPT", "title": "编后话", "kind": "prose",
             "paragraphs": pick([73, 74, 75, 76, 77, 78, 79, 80, 81]),
             "signature": pick([85, 86])},
            {"id": "EPILOGUE_1991", "title": "金德公跋（一九九一年）", "kind": "prose",
             "paragraphs": pick([91, 92, 93]), "signature": pick([96, 97]),
             "footnote": pick([100])},
            {"id": "REVISION_2015", "title": "樟裕校订说明（二零一五年）", "kind": "prose",
             "paragraphs": pick([102, 103]), "signature": pick([105, 106])},
            {"id": "REVISION_2022", "title": "樟裕续修说明（二零二二年）", "kind": "prose",
             "paragraphs": pick([112, 113, 115]), "signature": pick([117, 118])},
        ],
        "generationChars": [{"gen": g, "char": c, "position": p,
                             "proposer": "士仁公" if g <= 15 else "道公公"}
                            for g, c, p in GEN_CHARS],
    }
    (ROOT / "data" / "intro.json").write_text(
        json.dumps(intro, ensure_ascii=False, indent=1), encoding="utf-8")

    print("occurrences:", len(d["persons"]), "unique persons:", len(merged))
    print("spouses:", len(spouse_records), "notes:", len(d["notes"]))
    print("branch:", Counter(branch.values()).most_common())
    print("stats:", json.dumps(stats, ensure_ascii=False))
    print("issues:")
    for i in issues:
        print(f"  {i['code']} [{i['severity']}] {i['title']}: {i['count']}")
    print("written: data/genealogy.json, data/validation-report.json, data/intro.json")
