#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
compare_rules.py — 两种「父 → 子女」挂接规则的量化对照
---------------------------------------------------------------
背景
  原谱是二维网格：同一世代一列，父在上一段、子女在下一段，
  **子女的连续行块完整地属于一位父**，且各父的子女块**自上而下与父同序**。
  逐个子女取「行最近的父」（现行 R5 规则）会把一个连续的子女块
  从中间劈开，分给上下两位父 —— 这正是「错行」。

  已确认的两个反例（可证现行规则有误）：
    · 第 5 页 J271「世义」被判给怀裕 I269（行距 2），作者核定应归庆裕 I276。
      庆裕恰在子女块 271–282 的**中位行**上。
    · 第 5 页 I259「天裕」旁注「过继给盛茂为子」；行最近给出盛业 H257（并列），
      区块规则给出盛茂 H261（与旁注一致）。

规则
  R（纯逐人）：逐人取行距最小的父，并列时取行号较小者。
  S（现行发布）：R + **单一父块修正**——某子女所在「粗块」内只有一位父时，
                 该块子女全部归他（块的划分须计入配偶格，行差 > 3 才断开）。
                 修正只否决「最近父落在块外」，其余维持 R 原判（最小干预）。
  D（已否决）：先把子女列切分为行块，再按「父序 = 块序」做动态规划整体分派，
                 使 Σ|子女行 − 父行| 最小。**实测会灾难性并块**（第 7 页 14 名
                 子女全判给纹），故弃用；保留在此仅供回归比对。

用途
  用**文献明载**的父子关系（parentEvidence ∈ doc / note / spine / author）
  作为标准答案，比较三规则的命中率，再列出 R 与 S 不一致的全部个案，
  交人工核定。

用法
  python tools/compare_rules.py            # 打印对照报告
  python tools/compare_rules.py --diff     # 只打印两规则不一致的个案
"""
import json
import sys
from collections import defaultdict, Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GEN = ROOT / "data" / "genealogy.json"

SPLIT_GAP = 2          # 子女列中空行 ≥ 此值即切分为新块（1 表示逢空行即切）
EVIDENCE = {"doc", "note", "spine", "author"}


def load():
    d = json.loads((ROOT / "data" / "genealogy.json").read_text(encoding="utf-8"))
    return d["persons"]


def occ_on(p, page):
    for r in p.get("refs") or []:
        if r.get("page") == page:
            return r
    return None


def col_of_gen(persons, page):
    """该页「列 → 世代」映射（取各列非配偶人物世代数众数）"""
    m = defaultdict(Counter)
    for p in persons:
        if p.get("isSpouse") or p.get("unnamed"):
            continue
        r = occ_on(p, page)
        if not r:
            continue
        m[r["col"]][p["gen"]] += 1
    return {c: cnt.most_common(1)[0][0] for c, cnt in m.items()}


def blocks(rows, gap):
    """把有序行号切成连续块：相邻行号之差 > gap 即断开"""
    out, cur = [], []
    for r in rows:
        if cur and r - cur[-1] > gap:
            out.append(cur)
            cur = []
        cur.append(r)
    if cur:
        out.append(cur)
    return out


def rule_D(persons, page):
    """
    单调 DP 分派：返回 {子女id: 父id}（仅限本页本列对）

    模型
      原谱正文区的真实排布是「父位于其子女块的中点」——子女自上而下连续书写，
      父辈的排列顺序与子女块的顺序一致。故约束为：
        · 映射 φ: 子女 → 父 必须**非降**（子序与父序一致）；
        · 每位父领到的子女在行序上**连续**（自然由非降性给出）；
        · 允许父领零个子女（无嗣者）。
      目标：min Σ |子行 − 父行|。L1 范数的极小点即中位数，故该目标
      等价于「把每个连续子女块交给其中心最近的那位父」。

      与逐人「行最近」的区别：逐人判定在块边界处会把一个连续块劈成两半，
      分给上下两位父（第 5 页世义 J271 被判给怀裕 I269 即此因）；
      单调 DP 以整体代价最小为准，不会劈块。

    不预先切块——预切块会因阈值选择而人为割裂（实测 gap=2 时第 5 页
    255–264 被并成一块，反而误判）。
    """
    gen_of = col_of_gen(persons, page)
    gen_to_col = {g: c for c, g in gen_of.items()}
    on_page = [p for p in persons if occ_on(p, page)]
    res = {}

    for g, c in sorted(gen_to_col.items()):
        cn = gen_to_col.get(g + 1)
        if cn is None:
            continue
        fathers = sorted(
            [p for p in on_page
             if not p.get("isSpouse") and not p.get("unnamed")
             and p["gen"] == g and occ_on(p, page)["col"] == c],
            key=lambda p: occ_on(p, page)["row"])
        kids = sorted(
            [p for p in on_page
             if not p.get("isSpouse") and not p.get("unnamed")
             and p["gen"] == g + 1 and occ_on(p, page)["col"] == cn],
            key=lambda p: occ_on(p, page)["row"])
        if not fathers or not kids:
            continue
        frows = [occ_on(f, page)["row"] for f in fathers]
        crows = [occ_on(x, page)["row"] for x in kids]
        n, m = len(kids), len(fathers)
        INF = float("inf")

        def mid(a, b):
            """crows[a..b] 的中位数（L1 意义下的中心）"""
            seg = sorted(crows[a:b + 1])
            L = len(seg)
            return seg[L // 2] if L % 2 else (seg[L // 2 - 1] + seg[L // 2]) / 2.0

        # cost[k][i][j] = |块中位数 − 父行|：块 crows[k..i-1] 交给父 frows[j]
        cost = [[[0.0] * m for _ in range(n + 1)] for _ in range(n + 1)]
        for k in range(n):
            for i in range(k + 1, n + 1):
                md = mid(k, i - 1)
                for j in range(m):
                    cost[k][i][j] = abs(md - frows[j])

        dp = [[INF] * (m + 1) for _ in range(n + 1)]
        back = [[None] * (m + 1) for _ in range(n + 1)]
        for j in range(m + 1):
            dp[0][j] = 0
        for j in range(1, m + 1):
            for i in range(n + 1):
                # 父 j 不领子女
                if dp[i][j - 1] < dp[i][j]:
                    dp[i][j], back[i][j] = dp[i][j - 1], (i, j - 1)
                # 父 j 领第 k..i-1 个子女（k 从 i-1 递减到 0）
                for k in range(i - 1, -1, -1):
                    if dp[k][j - 1] == INF:
                        continue
                    cand = dp[k][j - 1] + cost[k][i][j - 1]
                    if cand < dp[i][j]:
                        dp[i][j], back[i][j] = cand, (k, j - 1)

        # 回溯：i 位置的父即第 j-1 位
        i, j = n, m
        while j > 0 and back[i][j] is not None:
            pi, pj = back[i][j]
            if pj == j - 1 and pi < i:
                for t in range(pi, i):
                    res[kids[t]["id"]] = fathers[j - 1]["id"]
            i, j = pi, pj
    return res


def rule_R(persons, page):
    """现行规则：逐人取行距最小父，并列取行号较小者"""
    gen_of = col_of_gen(persons, page)
    gen_to_col = {g: c for c, g in gen_of.items()}
    on_page = [p for p in persons if occ_on(p, page)]
    res = {}
    for g, c in sorted(gen_to_col.items()):
        cn = gen_to_col.get(g + 1)
        if cn is None:
            continue
        fathers = [p for p in on_page
                   if not p.get("isSpouse") and not p.get("unnamed")
                   and p["gen"] == g and occ_on(p, page)["col"] == c]
        if not fathers:
            continue
        for x in on_page:
            if x.get("isSpouse") or x.get("unnamed"):
                continue
            if x["gen"] != g + 1 or occ_on(x, page)["col"] != cn:
                continue
            xr = occ_on(x, page)["row"]
            best = min(fathers, key=lambda f: (abs(occ_on(f, page)["row"] - xr),
                                               occ_on(f, page)["row"]))
            res[x["id"]] = best["id"]
    return res


BLOCK_GAP = 3          # 行差 ≤ 此值视为同一「粗块」（与 build_data 一致）


def rule_S(persons, page):
    """
    现行**发布**规则：逐人「行距最近」+ **单一父块修正**。

    块 = 同一 (页, 列) 上相邻行差 ≤ BLOCK_GAP 的极大连续段（须计入**配偶格**，
    配偶占行、决定块是否连续）。若某子女所在块内**只有一位父**，则该块子女
    全部归他 —— 这是「一位父的子女连续书写」的直接推论。

    修正只**否决**「行距最近的父落在块外」这一种情形，其余维持行距最近原判，
    以免连带改动大量本无问题的挂接（最小干预原则）。
    """
    gen_of = col_of_gen(persons, page)
    gen_to_col = {g: c for c, g in gen_of.items()}
    on_page = [p for p in persons if occ_on(p, page)]

    block_id, block_span, bid = {}, {}, 0
    col_rows = defaultdict(set)
    for p in on_page:                      # 含配偶：配偶占行、决定块连续性
        col_rows[occ_on(p, page)["col"]].add(occ_on(p, page)["row"])
    for cl, rows in col_rows.items():
        prev = None
        for rw in sorted(rows):
            if prev is None or rw - prev > BLOCK_GAP:
                bid += 1
            block_id[(cl, rw)] = bid
            sp = block_span.setdefault(bid, [rw, rw])
            sp[0], sp[1] = min(sp[0], rw), max(sp[1], rw)
            prev = rw

    res = {}
    for g, c in sorted(gen_to_col.items()):
        cn = gen_to_col.get(g + 1)
        if cn is None:
            continue
        fathers = [p for p in on_page
                   if not p.get("isSpouse") and not p.get("unnamed")
                   and p["gen"] == g and occ_on(p, page)["col"] == c]
        if not fathers:
            continue
        for x in on_page:
            if x.get("isSpouse") or x.get("unnamed"):
                continue
            if x["gen"] != g + 1 or occ_on(x, page)["col"] != cn:
                continue
            xr = occ_on(x, page)["row"]
            best = min(fathers, key=lambda f: (abs(occ_on(f, page)["row"] - xr),
                                               occ_on(f, page)["row"]))
            sp = block_span.get(block_id.get((cn, xr)))
            if sp:
                inside = [f for f in fathers
                          if sp[0] <= occ_on(f, page)["row"] <= sp[1]]
                if len(inside) == 1:
                    best = inside[0]
            res[x["id"]] = best["id"]
    return res


def main():
    only_diff = "--diff" in sys.argv
    persons = load()
    by = {p["id"]: p for p in persons}
    pages = sorted({r["page"] for p in persons for r in (p.get("refs") or [])})

    D, R, S = {}, {}, {}
    for pg in pages:
        D.update(rule_D(persons, pg))
        R.update(rule_R(persons, pg))
        S.update(rule_S(persons, pg))

    # 标准答案：文献明载 / 主干行 / 作者核定
    truth = {p["id"]: p["fatherId"] for p in persons
             if p.get("fatherId") and p.get("parentEvidence") in EVIDENCE}

    def score(rule):
        hit = sum(1 for cid, fid in truth.items() if rule.get(cid) == fid)
        seen = sum(1 for cid in truth if cid in rule)
        return hit, seen, len(truth)

    if not only_diff:
        print("=" * 74)
        print("  父→子女 挂接规则对照")
        print("=" * 74)
        for nm, rule in (("R 纯逐人行最近", R),
                         ("S 现行发布（逐人 + 单一父块）", S),
                         ("D 已否决（区块 + 单调 DP）", D)):
            hit, seen, tot = score(rule)
            print(f"  {nm:<26} 命中 {hit}/{seen}（可判 {seen}/{tot} 例）"
                  f"　{'-' if not seen else '%.1f%%' % (100 * hit / seen)}")

    # 现行产出（build_data 结果）作为第三列
    built = {p["id"]: p["fatherId"] for p in persons if p.get("fatherId")}
    if not only_diff:
        hitb = sum(1 for cid, fid in truth.items() if built.get(cid) == fid)
        seenb = sum(1 for cid in truth if cid in built)
        print(f"  {'B 建模产物':<22} 命中 {hitb}/{seenb}"
              f"（可判 {seenb}/{len(truth)} 例）"
              f"　{'-' if not seenb else '%.1f%%' % (100 * hitb / seenb)}")

    # 差异清单：纯逐人 R 与现行发布 S 的差异（即「单一父块修正」实际改动了谁）
    diffs = []
    for cid in set(R) | set(S):
        a, b = R.get(cid), S.get(cid)
        if a != b:
            diffs.append((cid, a, b))
    diffs.sort(key=lambda t: (by[t[0]]["gen"], by[t[0]]["name"]))

    cur = built.get
    changed = [t for t in diffs if cur(t[0]) != t[2]]
    print()
    print(f"  R 与 S 不一致（即块修正实际改动）：{len(diffs)} 例；"
          f"其中 S 与建模产物仍不同：{len(changed)} 例")

    if only_diff or diffs:
        print("\n【差异明细】（行号取该页出现格）")
        print(f"  {'人物':<8}{'世':<4}{'页/格':<12}{'纯逐人R → 父':<18}{'现行S → 父':<18}证据")
        for cid, a, b in (changed if only_diff else diffs):
            p = by[cid]
            r = (p.get("refs") or [{}])[0]
            nm = lambda i: (by[i]["name"] if i in by else "—")
            cell = f"{r.get('page')}/{r.get('cell')}"
            ev = p.get("parentEvidence") or ""
            mark = " ← 文献" if ev in EVIDENCE else ""
            print(f"  {p['name']:<8}{p['gen']:<4}{cell:<12}"
                  f"{nm(a) + ('(' + str(by[a]['gen']) + '世)' if a in by else ''):<18}"
                  f"{nm(b) + ('(' + str(by[b]['gen']) + '世)' if b in by else ''):<18}{ev}{mark}")
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
