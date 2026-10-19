#!/usr/bin/env python3
"""
生成应用图标。

设计：渐变圆角方块 + 白色循环箭头 + 中间的对勾。

- 圆角方块与界面左上角的品牌标一致（蓝 → 紫渐变），保证应用内外观感连续
- 环形箭头表示「周期性重复执行」
- 对勾表示「签到已完成」
三者合起来就是产品语义：按时自动完成签到。

所有几何在 1024×1024 坐标系里定义，先按 4 倍超采样绘制再缩小，
以获得平滑边缘（PIL 的绘图没有抗锯齿）。

输出：
  build/icon.png    1024×1024，electron-builder 打包用
  build/icon.ico    Windows 多尺寸图标
  build/icon.icns   macOS 图标
  resources/icon.png 512×512，运行时窗口图标
"""

from __future__ import annotations

import math
import os
from PIL import Image, ImageDraw

# ---------- 设计参数 ----------

SIZE = 1024
SS = 4  # 超采样倍数

# 品牌渐变（与 renderer 里 .brand-mark 一致）
GRAD_START = (79, 140, 255)   # #4F8CFF
GRAD_END = (139, 92, 246)     # #8B5CF6

CORNER_RADIUS = 232
RING_RADIUS = 316
RING_WIDTH = 56
# 环从 RING_START 顺时针画到 RING_END。缺口落在右上（约 315°），
# 箭头与环尾都在缺口内，沿圆周方向摆放，指向顺时针前进方向。
# 缺口宽度决定箭头能放多大：这里的 70° 在 316 半径上约等于 386px 弧长。
RING_START = 12
RING_END = 264
HEAD_LEN = 104
HEAD_HALF = 64

CHECK_WIDTH = 74
CHECK_POINTS = [(392, 500), (492, 604), (646, 400)]


def lerp(a: int, b: int, t: float) -> int:
    return round(a + (b - a) * t)


def gradient(size: int) -> Image.Image:
    """对角线性渐变。先画小图再放大，避免逐像素处理大图。"""
    small = 256
    img = Image.new("RGB", (small, small))
    px = img.load()
    for y in range(small):
        for x in range(small):
            # 左上 → 右下的对角线参数
            t = (x + y) / (2 * (small - 1))
            px[x, y] = (
                lerp(GRAD_START[0], GRAD_END[0], t),
                lerp(GRAD_START[1], GRAD_END[1], t),
                lerp(GRAD_START[2], GRAD_END[2], t),
            )
    return img.resize((size, size), Image.LANCZOS)


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size * SS, size * SS), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle(
        (0, 0, size * SS - 1, size * SS - 1), radius=radius * SS, fill=255
    )
    return mask.resize((size, size), Image.LANCZOS)


def disc(draw: ImageDraw.ImageDraw, cx: float, cy: float, r: float, fill) -> None:
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=fill)


def build_icon(size: int = SIZE) -> Image.Image:
    s = size
    scale = s / SIZE

    # 背景
    canvas = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    bg = gradient(s).convert("RGBA")
    canvas.paste(bg, (0, 0), rounded_mask(s, round(CORNER_RADIUS * scale)))

    # 超采样图层：所有前景元素画在这里再缩回去
    fg = Image.new("RGBA", (s * SS, s * SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(fg)

    cx = cy = (s / 2) * SS
    ring_r = RING_RADIUS * scale * SS
    ring_w = RING_WIDTH * scale * SS
    box = (cx - ring_r, cy - ring_r, cx + ring_r, cy + ring_r)

    white = (255, 255, 255, 255)

    # 环形主体（PIL 的 arc 只支持递增角度，跨 0° 时拆成两段）
    if RING_START < RING_END:
        d.arc(box, start=RING_START, end=RING_END, fill=white, width=round(ring_w))
    else:
        d.arc(box, start=RING_START, end=360, fill=white, width=round(ring_w))
        d.arc(box, start=0, end=RING_END, fill=white, width=round(ring_w))

    sa = math.radians(RING_START)
    ea = math.radians(RING_END)
    # 环尾在 RING_END 处，接箭头；箭头沿顺时针切向指向前进方向
    ex, ey = cx + math.cos(ea) * ring_r, cy + math.sin(ea) * ring_r
    tx, ty = -math.sin(ea), math.cos(ea)          # 顺时针切线
    nx, ny = math.cos(ea), math.sin(ea)           # 径向（朝外）

    head_len = HEAD_LEN * scale * SS
    head_half = HEAD_HALF * scale * SS
    # 底边中心压进环体，让三角形与圆环连成一体（不留接缝也不留孤立的圆点）
    bx, by = ex - tx * ring_w * 0.55, ey - ty * ring_w * 0.55

    tip = (bx + tx * head_len, by + ty * head_len)
    b1 = (bx + nx * head_half, by + ny * head_half)
    b2 = (bx - nx * head_half, by - ny * head_half)
    d.polygon([tip, b1, b2], fill=white)

    # 环头（RING_START 一侧）补圆头收尾，避免被切断的观感
    disc(d, cx + math.cos(sa) * ring_r, cy + math.sin(sa) * ring_r, ring_w * 0.46, white)

    # 对勾
    pts = [(x * scale * SS, y * scale * SS) for x, y in CHECK_POINTS]
    lw = round(CHECK_WIDTH * scale * SS)
    d.line(pts, fill=white, width=lw, joint="curve")
    for x, y in (pts[0], pts[-1], pts[1]):
        disc(d, x, y, lw / 2, white)

    fg = fg.resize((s, s), Image.LANCZOS)
    canvas = Image.alpha_composite(canvas, fg)
    return canvas


def main() -> None:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    build_dir = os.path.join(root, "build")
    res_dir = os.path.join(root, "resources")
    os.makedirs(build_dir, exist_ok=True)
    os.makedirs(res_dir, exist_ok=True)

    master = build_icon(1024)

    master.save(os.path.join(build_dir, "icon.png"))
    master.resize((512, 512), Image.LANCZOS).save(os.path.join(res_dir, "icon.png"))

    # electron-builder 在 Windows 上优先用 build/icon.ico
    ico_sizes = [(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)]
    master.save(os.path.join(build_dir, "icon.ico"), sizes=ico_sizes)

    # macOS 图标
    try:
        master.save(os.path.join(build_dir, "icon.icns"))
        icns_note = "ok"
    except Exception as exc:  # noqa: BLE001
        icns_note = f"跳过（{exc}）"

    print("已生成：")
    print(f"  build/icon.png    1024x1024")
    print(f"  build/icon.ico    {', '.join(str(w) for w, _ in ico_sizes)}")
    print(f"  build/icon.icns   {icns_note}")
    print(f"  resources/icon.png 512x512")


if __name__ == "__main__":
    main()
