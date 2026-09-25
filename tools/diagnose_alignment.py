#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
diagnose_alignment.py — 世系「错行」风险排查
---------------------------------------------------------------
目的
  原谱是二维网格：父在上一世代列，妻在夫下一行，子女自妻行起向下排列。
  一旦子女被挂到**同列另一位父**名下，整支世系就会错行（如第 5 页
  世义 J271 被挂到怀裕 I269，实应归庆裕 I276）。

  本脚本逐页、逐「相邻世代列对」列出「父 → 子女所在行」，并标出风险：

  A 空巢父      —— 父有配偶却名下无子女（生父子女与过继子俱无），而同列
                  紧邻的下一位父有 ≥2 名子女。极可能是其子女被下方父「抢走」。
  B 行块交错    —— 两位父的子女行区间互相嵌套/交错（而非上下分段）。
                  正常情况下各父的子女应是**连续不重叠**的行块。
  C 远距挂接    —— 子女行与其父行相距过大（> 12 行），跨过了别的父。
  D 过继改位    —— 子女被挂到生父名下，却在**养父**的行位出现（原谱把出继子
                  同时列于生父行与养父行，故行距天然很大）。此项为**正常现象**，
                  单列出来只为说明 A/B/C 为何不计入它们，避免误判为错行。

关于「过继改位」为何必须豁免
  原谱惯例：出继子同时出现在生父行与养父行（跨页亦重复）。
  故其某一处出现格与**生父**相距甚远，却与**养父**紧邻——
  这不是错行，而是过继的版式后果。若不加豁免，A/B/C 会大量假阳性
  （实测：第 14 页爱德、第 27 页万昌、第 31 页学德 皆属此类）。

用法
  python tools/diagnose_alignment.py            # 打印报告，并写入 data/alignment-risk.txt
  python tools/diagnose_alignment.py --all      # 连正常的父→子行块一并列出

只读 data/genealogy.json（建模产出）。不复用 build_data.py 的任何代码。
"""
import json
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GEN = ROOT / "data" / "genealogy.json"
OUT = ROOT / "data" / "alignment-risk.txt"


def main():
    show_all = "--all" in sys.argv
    d = json.loads(GEN.read_text(encoding="utf-8"))
    persons = d["persons"]
    relations = d.get("relations", [])
    notes = d.get("notes", [])
    by = {p["id"]: p for p in persons}

    buf = []

    def emit(*a):
        s = " ".join(str(x) for x in a)
        buf.append(s)
        print(s)

    # ── 过继豁免集 ────────────────────────────────────────────────
    #   出继子（adoption 关系的 fromId）在原谱中会「改位」到养父行，
    #   其行距天然很大，不得据此判为错行。
    #   另：带「过继给X为子」（指名养父）或「为X之N子过继」（指名生父）
    #   旁注者，同样按出继子对待。
    adoptees, adoptive_fathers = set(), set()
    for r in relations:
        if r.get("type") == "adoption":
            if r.get("fromId"):
                adoptees.add(r["fromId"])
            if r.get("toId"):
                adoptive_fathers.add(r["toId"])
    for n in notes:
        if n.get("type") in ("adoption", "birth_father") and n.get("attachedToId"):
            adoptees.add(n["attachedToId"])

    kids = defaultdict(list)
    for p in persons:
        if p.get("fatherId"):
            kids[p["fatherId"]].append(p)

    # 一个人在原谱中常**跨页重复出现**，故必须按「该页上的那一格」比较行号，
    # 否则拿第 1 页的出现格去比第 20 页的子女，行距毫无意义（全是假阳性）。
    def occ(p, page=None):
        rs = p.get("refs") or []
        if page is not None:
            rs = [r for r in rs if r.get("page") == page]
        return rs[0] if rs else None

    def occ_pages(p):
        return {r.get("page") for r in (p.get("refs") or [])}

    groups = defaultdict(list)          # (page, gen) -> [father...]
    for p in persons:
        if p.get("isSpouse") or p.get("unnamed"):
            continue
        for pg in occ_pages(p):
            if pg is None:
                continue
            groups[(pg, p["gen"])].append(p)

    rowsA, rowsB, rowsC, rowsD = [], [], [], []

    for (page, gen), dads in sorted(groups.items(), key=lambda kv: (kv[0][0] or 0, kv[0][1])):
        if page is None:
            continue
        rec, seen_fid = [], set()
        for f in dads:
            if f["id"] in seen_fid:
                continue
            seen_fid.add(f["id"])
            fo = occ(f, page)
            if not fo:
                continue
            # 子女只保留**在本页有出现格**的：跨页出现的子女属于别页的排布
            ch_all = sorted([c for c in kids.get(f["id"], []) if occ(c, page)],
                            key=lambda c: occ(c, page).get("row", 0))
            # 出继子单独处理：其出现格是「养父行位」，不参与 A/B/C
            ch_ado = [c for c in ch_all if c["id"] in adoptees]
            ch = [c for c in ch_all if c["id"] not in adoptees]
            ch_rows = [occ(c, page).get("row") for c in ch]
            rec.append({"father": f, "row": fo.get("row"), "cell": fo.get("cell"),
                        "children": ch, "ch_rows": ch_rows, "ado": ch_ado,
                        "has_spouse": bool(f.get("spouseIds")),
                        "has_adopted": f["id"] in adoptive_fathers})

            # ── D 过继改位（正常现象，仅备案） ──────────────────
            for c in ch_ado:
                co = occ(c, page)
                if co and abs(co["row"] - fo.get("row")) > 12:
                    rowsD.append({
                        "page": page, "gen": gen,
                        "child": c["name"], "childCell": co.get("cell"),
                        "father": f["name"], "fatherRow": fo.get("row"),
                        "gap": abs(co["row"] - fo.get("row")),
                    })
        rec.sort(key=lambda x: x["row"])
        if not rec:
            continue

        # ── A 空巢父 ──────────────────────────────────────────
        #   过继父（名下有养子）不算空巢；名下有出继子者亦不算。
        for i, r in enumerate(rec):
            if r["children"] or r["ado"] or not r["has_spouse"] or r["has_adopted"]:
                continue
            nxt = rec[i + 1] if i + 1 < len(rec) else None
            if nxt and len(nxt["children"]) >= 2:
                rowsA.append({
                    "page": page, "gen": gen,
                    "father": r["father"]["name"], "cell": r["cell"], "row": r["row"],
                    "next": nxt["father"]["name"], "nextCell": nxt["cell"],
                    "nextRow": nxt["row"], "nextKids": len(nxt["children"]),
                })

        # ── B 行块交错 ────────────────────────────────────────
        holders = [(r, rr) for r in rec if r["ch_rows"] for rr in r["ch_rows"]]
        holders.sort(key=lambda t: t[1])
        seq = [t[0]["father"]["id"] for t in holders]
        # 若同一父的子女在行序列中被别的父打断，即为交错
        order = []
        for fid in seq:
            if not order or order[-1] != fid:
                order.append(fid)
        if len(order) > len({r["father"]["id"] for r in rec if r["ch_rows"]}):
            names = [by[f]["name"] for f in order]
            rowsB.append({"page": page, "gen": gen, "order": names})

        # ── C 远距挂接 ────────────────────────────────────────
        all_rows = sorted(r["row"] for r in rec)
        for r in rec:
            for c in r["children"]:
                co = occ(c, page)
                if not co:
                    continue
                between = [x for x in all_rows
                           if min(r["row"], co["row"]) < x < max(r["row"], co["row"])]
                if len(between) >= 1 and abs(co["row"] - r["row"]) > 12:
                    rowsC.append({"page": page, "gen": gen,
                                  "father": r["father"]["name"], "fatherRow": r["row"],
                                  "child": c["name"], "childCell": co.get("cell"),
                                  "gap": abs(co["row"] - r["row"]), "between": len(between)})

        if show_all:
            emit(f"\n── 第 {page} 页 · 第 {gen} 世 ──")
            for r in rec:
                kids_s = "、".join(
                    "%s(%s)" % (c["name"], occ(c, page).get("cell"))
                    for c in r["children"]) or "—"
                ado_s = ("  ［过继改位：%s］" % "、".join(
                    "%s(%s)" % (c["name"], occ(c, page).get("cell")) for c in r["ado"])) if r["ado"] else ""
                emit("  %-6s %-8s 行%-5d 子女：%s%s"
                     % (r["cell"], r["father"]["name"], r["row"], kids_s, ado_s))

    emit("=" * 74)
    emit("  世系错行风险排查")
    emit("=" * 74)
    emit(f"  A 空巢父（有配偶无子女，且下一位父子女 ≥2）      ：{len(rowsA)} 处")
    emit(f"  B 子女行块交错（同一父的子女被别的父打断）        ：{len(rowsB)} 处")
    emit(f"  C 远距挂接（跨过别的父，行距 > 12）              ：{len(rowsC)} 处")
    emit(f"  D 过继改位（正常：出继子出现在养父行位，已豁免）  ：{len(rowsD)} 处")
    emit("=" * 74)

    if rowsA:
        emit("\n【A】空巢父 —— 请重点核对，其子女很可能被下方父错收：\n")
        for a in rowsA:
            emit("  第%2d页 %2d世  %s「%s」(行%d) 有配偶无子女；"
                 "紧邻下一位 %s「%s」(行%d) 却有 %d 名子女"
                 % (a["page"], a["gen"], a["cell"], a["father"], a["row"],
                    a["nextCell"], a["next"], a["nextRow"], a["nextKids"]))

    if rowsB:
        emit("\n【B】子女行块交错 —— 正常应上下分段，交错说明有错行：\n")
        for b in rowsB:
            emit("  第%2d页 %2d世  子女按行序所属父：%s"
                 % (b["page"], b["gen"], " → ".join(b["order"])))

    if rowsC:
        emit("\n【C】远距挂接 —— 子女与其父之间还隔着别的父：\n")
        for c in rowsC:
            emit("  第%2d页 %2d世  「%s」%s 挂到 %s(行%d)，行距 %d，中间隔 %d 位父"
                 % (c["page"], c["gen"], c["child"], c["childCell"],
                    c["father"], c["fatherRow"], c["gap"], c["between"]))

    if rowsD:
        emit("\n【D】过继改位 —— 正常现象（出继子列于养父行位），仅供核对，非错行：\n")
        for x in rowsD:
            emit("  第%2d页 %2d世  「%s」%s 生父 %s(行%d)，行距 %d（因过继改位于养父行）"
                 % (x["page"], x["gen"], x["child"], x["childCell"],
                    x["father"], x["fatherRow"], x["gap"]))

    if not (rowsA or rowsB or rowsC):
        emit("\n  未发现错行风险。\n")

    OUT.write_text("\n".join(buf) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
