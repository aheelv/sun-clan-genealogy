#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
diagnose_merge.py — 同名异人「误合并」独立排查
---------------------------------------------------------------
不依赖 tools/build_data.py 的任何代码，只读：
  · data/source/chart-raw.json   原谱逐格转录（事实基线）
  · data/genealogy.json          建模产出（被检对象）

原理
  原谱版式规定：某人的父系落在**同页、列号减 1**的格子上（同行优先，否则取最近行）。
  因此每个「出现格」都有一条**自身**的邻接父线索。
  若一个人物记录包含多个出现格，而这些出现格的邻接父**互不相同**，
  说明这些格子很可能分属不同的人 —— 即发生了同名异人误合并。

输出：受影响的记录清单 + 按同名组汇总。
"""
import json
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "source" / "chart-raw.json"
GEN = ROOT / "data" / "genealogy.json"


def load():
    raw = json.loads(RAW.read_text(encoding="utf-8"))
    sheet = raw["sheets"][0]
    cells = sheet["cells"]

    # 页切分：以「孙氏世系图表 第NN页」标题行定位
    titles = sorted(
        (c for c in cells if "孙氏世系图表" in str(c.get("value", ""))),
        key=lambda c: c["row"],
    )
    bounds = [t["row"] for t in titles]
    pages = []
    for i, start in enumerate(bounds):
        end = bounds[i + 1] - 1 if i + 1 < len(bounds) else sheet["maxRow"]
        pages.append((i + 1, start, end))

    def page_of(row):
        for pg, a, b in pages:
            if a <= row <= b:
                return pg
        return None

    # 逐格索引（只保留人物格：非空、非标题、非表头）
    by_cell = {}
    for c in cells:
        v = str(c.get("value", "")).strip()
        if not v:
            continue
        by_cell[(c["row"], c["col"])] = v

    return cells, by_cell, page_of


def norm_refs(p):
    """出处格在 genealogy.json 中为对象，在 seed.js 中压缩为 [page,row,col,raw]。
    两种形态都归一化为 {'row','col','page','cell'}。"""
    out = []
    for r in (p.get("refs") or []):
        if isinstance(r, dict):
            out.append({"row": r["row"], "col": r["col"], "page": r.get("page"),
                        "cell": r.get("cell") or r.get("ref") or ""})
        elif isinstance(r, (list, tuple)) and len(r) >= 3:
            out.append({"page": r[0], "row": r[1], "col": r[2], "cell": ""})
    return out


def main():
    # 可指定被检对象（默认 data/genealogy.json）；用于对旧版数据做敏感性自检，
    # 确认本脚本确实能抓出已修复的历史缺陷，而不是「永远报 0」。
    subj = Path(sys.argv[1]) if len(sys.argv) > 1 else GEN
    cells, by_cell, page_of = load()
    gen = json.loads(subj.read_text(encoding="utf-8"))
    persons = gen["persons"]

    # 只有「人物格」才可能成为父系候选。人物格集合取自产出自身声明的出处格
    # （主干人物 + 配偶），这样表头（「三代」）、拼音标注（「lang四声」）、
    # 交叉引用（「见20页」）、旁注（「韩氏生」）等非人物格都会被排除。
    person_cells = set()
    for p in persons:
        for r in norm_refs(p):
            person_cells.add((r["row"], r["col"]))
    spouse_cells = set()
    for p in persons:
        if p.get("isSpouse"):
            for r in norm_refs(p):
                spouse_cells.add((r["row"], r["col"]))

    # 含「过继」旁注的行：过继子的生父行与养父行天然给出两个不同的父。
    # 注意旁注写在人物所在行的**下方配偶行**上（如 D1944=士蘭，其下 E1945=「过继给顕为子」），
    # 故判定时按 ±2 行开窗。
    adopt_rows = set()
    for c in cells:
        if "过继" in str(c.get("value", "")):
            adopt_rows.add(c["row"])

    def adopt_row(row):
        return any((row + d) in adopt_rows for d in (-2, -1, 0, 1, 2))

    def ok_parent_cell(r, c):
        return (r, c) in person_cells and (r, c) not in spouse_cells

    def local_parent_name(row, col):
        """独立重算「邻接父」：同页、列号减 1，同行优先，否则最近行。"""
        if col <= 1:
            return None
        if ok_parent_cell(row, col - 1):
            return by_cell[(row, col - 1)]
        cands = []
        for (r, c), v in by_cell.items():
            if c == col - 1 and page_of(r) == page_of(row) and ok_parent_cell(r, c):
                cands.append((abs(r - row), 0 if r <= row else 1, r, v))
        if not cands:
            return None
        cands.sort()
        return cands[0][3]

    suspects = []
    for p in persons:
        if p.get("isSpouse"):
            continue                     # 配偶的「列号减 1」是丈夫/其他配偶，不是父系
        refs = norm_refs(p)
        if len(refs) < 2:
            continue
        clues = []
        for r in refs:
            nm = local_parent_name(r["row"], r["col"])
            cell = r["cell"] or "r%dc%d" % (r["row"], r["col"])
            pg = r["page"] if r["page"] is not None else page_of(r["row"])
            clues.append((cell, pg, nm))
        names = {c[2] for c in clues if c[2]}
        if len(names) <= 1:
            continue
        # 过继：生父行与养父行必然给出两个不同的父，这是**正常**的，
        # 旁注「过继给X为子」即写在生父行上。此类不计为误合并。
        if any(adopt_row(r["row"]) for r in refs):
            continue
        suspects.append({"person": p, "clues": clues, "parents": sorted(names)})

    print("=" * 74)
    print("  同名异人误合并 · 独立排查")
    print("=" * 74)
    print(f"  人物记录总数 {len(persons)}；含 2 个以上出现格者 "
          f"{sum(1 for p in persons if len(norm_refs(p)) > 1)} 条")
    print(f"  邻接父线索互相矛盾（疑似误合并）：{len(suspects)} 条")
    print("=" * 74)

    if not suspects:
        print("\n  未发现疑似误合并。\n")
        return 0

    groups = defaultdict(list)
    for s in suspects:
        groups[s["person"]["name"]].append(s)

    print(f"\n  涉及 {len(groups)} 个同名组：\n")
    for name in sorted(groups, key=lambda n: (-len(groups[n]), n)):
        lst = groups[name]
        print(f"  ── 「{name}」 {len(lst)} 条记录 ──")
        for s in lst:
            p = s["person"]
            print(f"     {p['id']}  {p['gen']}世  支系={p.get('branchId')}  "
                  f"父={p.get('fatherId')}")
            for cell, pg, nm in s["clues"]:
                print(f"        出处 {cell:<6} 第{pg:>2}页  邻接父={nm or '（未解析）'}")
        print()

    # 逐条明细，便于机器消费
    out = ROOT / "data" / "merge-suspects.json"
    out.write_text(json.dumps([
        {
            "id": s["person"]["id"], "name": s["person"]["name"],
            "gen": s["person"]["gen"], "branchId": s["person"].get("branchId"),
            "fatherId": s["person"].get("fatherId"),
            "clues": [{"cell": c, "page": pg, "localParent": nm} for c, pg, nm in s["clues"]],
            "parents": s["parents"],
        } for s in suspects
    ], ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  明细已写入 {out.relative_to(ROOT)}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
