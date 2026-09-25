# -*- coding: utf-8 -*-
"""
extract_xlsx.py — 孙氏族谱.xlsx 无损转录器

把工作簿的每个非空单元格转成 {sheet,row,col,ref,value} 记录，
并导出合并单元格区域，作为族谱数据建模的"唯一事实来源"(SSOT)。

用法：
    python extract_xlsx.py <input.xlsx> <output.json>
"""
import json
import sys
from pathlib import Path

from openpyxl import load_workbook
from openpyxl.utils import get_column_letter


def main():
    src = Path(sys.argv[1])
    dst = Path(sys.argv[2])
    wb = load_workbook(str(src), data_only=False, read_only=False)

    sheets = []
    for ws in wb.worksheets:
        cells = []
        for row in ws.iter_rows():
            for c in row:
                v = c.value
                if v is None:
                    continue
                s = str(v)
                if s.strip() == "" and s == "":
                    continue
                cells.append({
                    "row": c.row,
                    "col": c.column,
                    "ref": c.coordinate,
                    "value": s,
                })
        merges = [str(m) for m in ws.merged_cells.ranges]
        sheets.append({
            "name": ws.title,
            "maxRow": ws.max_row,
            "maxCol": ws.max_column,
            "mergedRanges": merges,
            "cellCount": len(cells),
            "cells": cells,
        })

    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(
        json.dumps({"source": str(src), "sheets": sheets}, ensure_ascii=False),
        encoding="utf-8",
    )
    for s in sheets:
        print(f"  {s['name']}: {s['cellCount']} cells, {len(s['mergedRanges'])} merges")
    print(f"OK -> {dst}")


if __name__ == "__main__":
    main()
