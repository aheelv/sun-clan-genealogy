#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
tools/make_qr.py — 生成站点访问二维码卡片
---------------------------------------------------------------
输出一张可直接分享／打印的 PNG：中秋意象 + 谱名 + 二维码 + 访问地址。
配色取自站点主题 assets/css/theme.css 的调色板，视觉与站点一致。

二维码采用 **深色模块 + 浅色底**（而非反相），因为绝大多数扫码器对
「深底浅块」的识别率更低；中心嵌「孙」字标识，靠 H 级纠错（30%）容错。

用法：
    python tools/make_qr.py [URL] [输出路径]

默认 URL 为 GitHub Pages 站点地址；仅依赖 qrcode + Pillow。
"""

import sys
from pathlib import Path

import qrcode
from qrcode.constants import ERROR_CORRECT_H
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_URL = "https://aheelv.github.io/sun-clan-genealogy/"

# ── 站点调色板（assets/css/theme.css） ──────────────────────
PAPER_0 = (253, 250, 243)
PAPER_1 = (247, 241, 228)
PAPER_2 = (239, 230, 211)
LINE = (222, 208, 180)
INK_0 = (34, 28, 21)
INK_2 = (107, 97, 81)
INK_3 = (154, 143, 124)
GOLD_0 = (138, 97, 20)
GOLD_1 = (181, 134, 43)
GOLD_2 = (216, 171, 78)
GOLD_3 = (240, 211, 140)
CINNABAR = (168, 56, 42)

FONT_DIR = Path("C:/Windows/Fonts")
F_KAI = FONT_DIR / "STKAITI.TTF"      # 华文楷体 —— 谱名，楷体合族谱气质
F_UI = FONT_DIR / "msyh.ttc"          # 微软雅黑 —— 说明文字
F_UI_B = FONT_DIR / "msyhbd.ttc"      # 微软雅黑 粗
F_MONO = FONT_DIR / "Deng.ttf"        # 等线 —— 地址，字形接近等宽

W = 1000
M = 44          # 外边距
PAD = 26        # 内边距


def font(path: Path, size: int) -> ImageFont.FreeTypeFont:
    if not path.exists():
        raise SystemExit(f"缺少字体：{path}")
    return ImageFont.truetype(str(path), size)


def text_size(draw, text, fnt):
    l, t, r, b = draw.textbbox((0, 0), text, font=fnt)
    return r - l, b - t


def center_text(draw, y, text, fnt, fill):
    """以 y 为文字顶部，水平居中绘制；返回底部 y。"""
    w, h = text_size(draw, text, fnt)
    draw.text(((W - w) / 2, y), text, font=fnt, fill=fill)
    return y + h


def build_matrix(url: str):
    qr = qrcode.QRCode(error_correction=ERROR_CORRECT_H, border=0, box_size=1)
    qr.add_data(url)
    qr.make(fit=True)
    return qr.get_matrix()


def main():
    url = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_URL
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / "qr-site.png"

    matrix = build_matrix(url)
    n = len(matrix)

    # 每个模块的像素边长：让「二维码 + 4 模块静区 + 视觉留白」整体约 560px
    target = 560
    box = max(6, int(round((target - 2 * PAD) / (n + 8))))
    quiet = 4 * box                       # QR 规范要求的静区
    qr_size = n * box
    panel = qr_size + 2 * quiet + 2 * PAD

    # ── 版面纵向排布（先算好总高，再建画布） ──
    y_moon = M + 96                       # 月亮圆心（须让月牙上缘离内框足够远）
    moon_r = 56
    cursor = y_moon + moon_r + 44

    title_f = font(F_KAI, 104)
    sub_f = font(F_UI, 33)
    tag_f = font(F_UI, 27)
    url_f = font(F_MONO, 30)
    foot_f = font(F_UI, 24)
    seal_f = font(F_KAI, 46)

    # 预估高度：用一次性草稿画布测量文本高度
    probe = Image.new("RGB", (10, 10))
    pd = ImageDraw.Draw(probe)
    _, h_title = text_size(pd, "孙氏族谱", title_f)
    _, h_sub = text_size(pd, "中秋主题静态族谱站点", sub_f)
    _, h_tag = text_size(pd, "收录 1,752 人 · 14 世 · 31 页原谱", tag_f)
    _, h_url = text_size(pd, url, url_f)
    _, h_foot = text_size(pd, "手机相机扫码即可打开 · 无需安装", foot_f)

    y_title = cursor
    y_sub = y_title + h_title + 26
    y_tag = y_sub + h_sub + 16
    y_rule = y_tag + h_tag + 38
    y_panel = y_rule + 40
    y_url = y_panel + panel + 44
    y_foot = y_url + h_url + 32
    # 内框在 H-M-12，页脚文字底须留出净空，否则会被框线穿过
    H = int(y_foot + h_foot + M + 46)

    img = Image.new("RGB", (W, H), PAPER_1)
    d = ImageDraw.Draw(img)

    # ── 双线外框（宣纸版式） ──
    d.rectangle([M, M, W - M - 1, H - M - 1], outline=GOLD_2, width=3)
    d.rectangle([M + 11, M + 11, W - M - 12, H - M - 12], outline=GOLD_3, width=1)

    # ── 圆月：金圆 + 偏移的纸色圆 ⇒ 弦月（与站点 favicon 同一手法） ──
    cx = W // 2
    d.ellipse([cx - moon_r, y_moon - moon_r, cx + moon_r, y_moon + moon_r], fill=GOLD_2)
    ox, oy, orr = 32, -26, 46
    d.ellipse([cx + ox - orr, y_moon + oy - orr, cx + ox + orr, y_moon + oy + orr], fill=PAPER_1)
    # 几点桂花，呼应「桂影」
    for dx, dy, rr in ((-118, -6, 4), (-104, 26, 3), (112, 14, 4), (98, -22, 3), (86, 44, 3)):
        d.ellipse([cx + dx - rr, y_moon + dy - rr, cx + dx + rr, y_moon + dy + rr], fill=GOLD_3)

    # ── 谱名与说明 ──
    center_text(d, y_title, "孙氏族谱", title_f, INK_0)
    center_text(d, y_sub, "中秋主题静态族谱站点", sub_f, INK_2)
    center_text(d, y_tag, "收录 1,752 人 · 14 世 · 31 页原谱", tag_f, INK_3)

    # ── 分隔线：中间一枚菱形 ──
    half = 190
    d.line([cx - half, y_rule, cx - 16, y_rule], fill=GOLD_2, width=2)
    d.line([cx + 16, y_rule, cx + half, y_rule], fill=GOLD_2, width=2)
    d.polygon([(cx, y_rule - 8), (cx + 8, y_rule), (cx, y_rule + 8), (cx - 8, y_rule)], fill=GOLD_1)

    # ── 二维码面板（含规范静区） ──
    px0 = (W - panel) // 2
    py0 = y_panel
    d.rounded_rectangle([px0, py0, px0 + panel - 1, py0 + panel - 1], radius=14,
                        fill=PAPER_0, outline=LINE, width=2)

    qx = px0 + quiet + PAD
    qy = py0 + quiet + PAD
    for r, row in enumerate(matrix):
        for c, on in enumerate(row):
            if on:
                x0 = qx + c * box
                y0 = qy + r * box
                d.rectangle([x0, y0, x0 + box - 1, y0 + box - 1], fill=INK_0)

    # ── 中心「孙」字标识（H 级纠错容错 30%，此处仅占约 2.6% 面积） ──
    logo = max(46, int(qr_size * 0.17))
    lx = px0 + panel // 2 - logo // 2
    ly = py0 + panel // 2 - logo // 2
    d.rounded_rectangle([lx, ly, lx + logo, ly + logo], radius=8, fill=PAPER_0, outline=GOLD_2, width=2)
    sw, sh = text_size(d, "孙", seal_f)
    d.text((lx + (logo - sw) / 2, ly + (logo - sh) / 2), "孙", font=seal_f, fill=CINNABAR)

    # ── 访问地址 ──
    center_text(d, y_url, url, url_f, GOLD_0)
    center_text(d, y_foot, "手机相机扫码即可打开 · 无需安装", foot_f, INK_3)

    img.save(out, "PNG", optimize=True)
    print(f"已生成：{out}")
    print(f"  尺寸 {img.width}×{img.height}  二维码 {n}×{n} 模块  box={box}px  面板 {panel}px")
    print(f"  目标地址 {url}")


if __name__ == "__main__":
    main()
