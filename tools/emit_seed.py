# -*- coding: utf-8 -*-
"""
emit_seed.py — 把 data/*.json 打包为站点内联种子模块 assets/js/data/seed.js

内联（而非 fetch）是为了让 index.html 双击即可打开（file:// 下 fetch 会被同源策略拦截）。

用法：python emit_seed.py
"""
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CST = timezone(timedelta(hours=8))

g = json.loads((ROOT / "data" / "genealogy.json").read_text(encoding="utf-8"))
intro = json.loads((ROOT / "data" / "intro.json").read_text(encoding="utf-8"))
report = json.loads((ROOT / "data" / "validation-report.json").read_text(encoding="utf-8"))

# 独立交叉校验报告：与构建期校验（validation-report）互补，随种子一并入站，
# 使「校验中心」与「概览」无需 fetch 即可展示第三方口径的核验结果。
verif_path = ROOT / "data" / "verification-report.json"
verif = json.loads(verif_path.read_text(encoding="utf-8")) if verif_path.exists() else None

# 精简人物：去掉可由其他字段推导的冗余项
persons = []
for p in g["persons"]:
    persons.append({
        "id": p["id"],
        "name": p["name"],
        "surname": p.get("surname"),
        "givenName": p.get("givenName"),
        "gender": p["gender"],
        "isSpouse": p["isSpouse"],
        "unnamed": p.get("unnamed", False),
        "gen": p["gen"],
        "branchId": p["branchId"],
        "branchKey": p["branchKey"],
        "status": p["status"],
        "pinyin": p.get("pinyin"),
        "namedSpouse": p.get("namedSpouse", False),
        "fatherId": p.get("fatherId"),
        "spouseOfId": p.get("spouseOfId"),
        "spouseIds": p.get("spouseIds", []),
        "childrenIds": p.get("childrenIds", []),
        "parentEvidence": p.get("parentEvidence"),
        "confidence": p.get("confidence", {}),
        "notes": p.get("notes", []),
        # 出处压缩为 [page,row,col,raw]
        "refs": [[r["page"], r["row"], r["col"], r["raw"]] for r in p.get("refs", [])],
    })

# 只保留不可由人物字段推导的关系（过继）；父子/婚姻由 store 派生
adoptions = [r for r in g["relations"] if r["type"] == "adoption"]

seed = {
    "meta": g["meta"],
    "generations": g["generations"],
    "branches": g["branches"],
    "persons": persons,
    "adoptions": adoptions,
    "intro": intro,
    "buildReport": {"totals": report["totals"],
                    "issues": [{k: i[k] for k in ("code", "severity", "title", "detail", "count")}
                               for i in report["issues"]]},
    "verification": verif,
    "emittedAt": datetime.now(CST).isoformat(timespec="seconds"),
}

out = ROOT / "assets" / "js" / "data" / "seed.js"
out.parent.mkdir(parents=True, exist_ok=True)
body = json.dumps(seed, ensure_ascii=False, separators=(",", ":"))
out.write_text(
    "/* 自动生成，请勿手工编辑 —— 由 tools/emit_seed.py 从 data/genealogy.json 生成 */\n"
    "export const SEED = " + body + ";\n"
    "export default SEED;\n",
    encoding="utf-8",
)
print(f"persons={len(persons)} adoptions={len(adoptions)} bytes={out.stat().st_size:,} -> {out}")
