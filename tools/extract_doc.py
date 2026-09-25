# -*- coding: utf-8 -*-
"""
extract_doc.py — Word 97-2003 (.doc, OLE2/CFB) 正文无损文本提取器

不依赖 Word/WPS/LibreOffice，直接按 MS-DOC 规范解析 FIB -> Clx -> PlcPcd 分片表，
再按分片编码（compressed=ANSI / 非压缩=UTF-16LE）还原正文，保留段落与特殊标记。

用法：
    python extract_doc.py <input.doc> <output.json>
"""
import json
import struct
import sys
from pathlib import Path

import olefile

# MS-DOC 特殊控制字符
SPECIAL = {
    "\x00": "",       # 占位
    "\x01": "\u3010图\u3011",   # 内嵌图片
    "\x02": "",       # 脚注引用
    "\x05": "",       # 批注引用
    "\x07": "\u241E",  # 单元格/行结束
    "\x08": "\u2408",  # 图形
    "\x09": "\t",
    "\x0b": "\n",     # 手动换行
    "\x0c": "\f",     # 分页
    "\x0e": "",       # 分栏
    "\x13": "", "\x14": "", "\x15": "",  # 域标记
    "\x1e": "\u2011",  # 不换行连字符
    "\x1f": "",       # 可选连字符
    "\xa0": " ",
}


def _read_fib(ole):
    wd = ole.openstream("WordDocument").read()
    flags = struct.unpack_from("<H", wd, 0x0A)[0]
    which = (flags >> 9) & 1
    fc_clx = struct.unpack_from("<i", wd, 0x01A2)[0]
    lcb_clx = struct.unpack_from("<i", wd, 0x01A6)[0]
    ccp_text = struct.unpack_from("<i", wd, 0x004C)[0]
    tbl = "1Table" if which else "0Table"
    if not ole.exists(tbl):
        tbl = "1Table" if ole.exists("1Table") else "0Table"
    return wd, ole.openstream(tbl).read(), fc_clx, lcb_clx, ccp_text


def _parse_clx(tbl, fc_clx, lcb_clx):
    clx = tbl[fc_clx:fc_clx + lcb_clx]
    i = 0
    while i < len(clx):
        t = clx[i]
        if t == 0x01:                      # Prc
            cb = struct.unpack_from("<h", clx, i + 1)[0]
            i += 3 + cb
        elif t == 0x02:                    # Pcdt
            lcb = struct.unpack_from("<i", clx, i + 1)[0]
            return clx[i + 5: i + 5 + lcb]
        else:
            break
    raise ValueError("Clx 中未找到 Pcdt")


def _decode_piece(data, compressed):
    if compressed:
        for enc in ("cp936", "cp1252"):
            try:
                return data.decode(enc)
            except UnicodeDecodeError:
                continue
        return data.decode("cp936", errors="replace")
    return data.decode("utf-16-le", errors="replace")


def extract_text(path):
    ole = olefile.OleFileIO(str(path))
    wd, tbl, fc_clx, lcb_clx, ccp_text = _read_fib(ole)
    plc = _parse_clx(tbl, fc_clx, lcb_clx)

    n = (len(plc) - 4) // 12
    cps = [struct.unpack_from("<i", plc, 4 * k)[0] for k in range(n + 1)]
    pieces = []
    for k in range(n):
        off = 4 * (n + 1) + 8 * k
        fc = struct.unpack_from("<I", plc, off + 2)[0]
        compressed = bool(fc & 0x40000000)
        real_fc = (fc & 0x3FFFFFFF) // 2 if compressed else (fc & 0x3FFFFFFF)
        pieces.append((cps[k], cps[k + 1], real_fc, compressed))

    out = []
    for cp_s, cp_e, real_fc, compressed in pieces:
        if cp_s >= ccp_text:
            continue
        cp_e = min(cp_e, ccp_text)
        count = cp_e - cp_s
        if compressed:
            raw = wd[real_fc: real_fc + count]
        else:
            raw = wd[real_fc: real_fc + count * 2]
        out.append(_decode_piece(raw, compressed))
    ole.close()

    text = "".join(out)
    for k, v in SPECIAL.items():
        text = text.replace(k, v)
    return text


def to_paragraphs(text):
    paras = []
    for raw in text.replace("\r", "\n").split("\n"):
        paras.append(raw.rstrip())
    return paras


def main():
    src = Path(sys.argv[1])
    dst = Path(sys.argv[2])
    text = extract_text(src)
    paras = to_paragraphs(text)
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(
        json.dumps(
            {
                "source": str(src),
                "charCount": len(text),
                "paragraphCount": len(paras),
                "paragraphs": paras,
            },
            ensure_ascii=False,
            indent=1,
        ),
        encoding="utf-8",
    )
    print(f"OK chars={len(text)} paragraphs={len(paras)} -> {dst}")


if __name__ == "__main__":
    main()
