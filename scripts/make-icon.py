#!/usr/bin/env python3
"""
生成应用图标。

设计：渐变圆角方块 + 环形箭头 + 中间的对勾。

- 圆角方块与界面左上角的品牌标一致（蓝 → 紫渐变），保证应用内外观感连续
- 环形箭头表示「周期性重复执行」
- 对勾表示「签到已完成」
三者合起来就是产品语义：按时自动完成签到。

尺寸按 macOS 的图标网格来定，而不是撑满画布：
macOS 的 1024 画布上，圆角方块的视觉边长约 824，四周各留约 100 的
透明边距，圆角半径约为块边长的 22.4%。直接铺满画布在 Dock 里会显得
比系统应用大一圈、也更糊，这是之前 macOS 上观感差的主要原因。

所有几何在 1024 坐标系里定义，先按超采样倍数绘制再缩小，
以获得平滑边缘（PIL 的绘图没有抗锯齿）。

输出：
  build/icon.png     1024×1024，electron-builder 打包用
  build/icon.ico     Windows 多尺寸图标
  build/icon.icns    macOS 图标
  resources/icon.png 512×512，运行时窗口图标
"""

from __future__ import annotations

import math
import os
from PIL import Image, ImageDraw, ImageFilter

# ---------- 设计参数 ----------

SIZE = 1024
SS = 4  # 超采样倍数

# macOS 图标网格：方块占画布的 80.5%，居中，四周留白
BLOCK = 824
BLOCK_OFFSET = (SIZE - BLOCK) // 2          # 100
CORNER_RADIUS = round(BLOCK * 0.2237)       # ≈ 184，贴近系统图标的圆角比例

# 前景元素（按 1024 画布坐标设计）
RING_RADIUS = 250
RING_WIDTH = 58
# 接近整圈的环：从 300° 顺时针画到 240°（跨过 0°，共 300°），
# 缺口在正上方偏右。箭头接在 240° 这端、沿切线指向上方，
# 形成「循环一周、继续前行」的读法。
RING_START = 300
RING_END = 240
HEAD_LEN = 112
# 底边要比环宽很多：箭头根部才能完全盖住弧的平切端点，
# 否则弧的两侧会在缺口处各露出一个小尖，看起来像破损
HEAD_HALF = 88

CHECK_WIDTH = 74
CHECK_POINTS = [(398, 520), (482, 606), (630, 428)]

# 品牌渐变（与 renderer 里 .brand-mark 一致）
GRAD_START = (79, 140, 255)   # #4F8CFF
GRAD_END = (139, 92, 246)     # #8B5CF6


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


def build_block(size: int, padding_ratio: float = 0.0, weight: float = 1.0) -> Image.Image:
    """
    只画方块本体（渐变 + 前景图形），按 SIZE 坐标系布局。

    padding_ratio 覆盖默认留白（小尺寸图标用更小的留白）；
    weight 统一加粗前景线宽（小尺寸下让图形更实）。
    """
    s = size
    scale = s / SIZE

    if padding_ratio:
        block = round(s * (1 - padding_ratio * 2))
        offset = round(s * padding_ratio)
        radius = round(block * 0.2237)
    else:
        block = round(BLOCK * scale)
        offset = round(BLOCK_OFFSET * scale)
        radius = round(CORNER_RADIUS * scale)

    # 渐变方块
    canvas = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    bg = gradient(block).convert("RGBA")
    canvas.paste(bg, (offset, offset), rounded_mask(block, radius))

    # 超采样图层：所有前景元素画在这里再缩回去
    fg = Image.new("RGBA", (s * SS, s * SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(fg)

    cx = cy = (s / 2) * SS
    ring_r = RING_RADIUS * scale * SS
    ring_w = RING_WIDTH * scale * SS * weight
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
    # 箭头接在弧的末端（RING_END），沿顺时针切线指向前进方向；
    # 底边中心压进环体，让三角形和圆弧连成一体。
    hx, hy = cx + math.cos(ea) * ring_r, cy + math.sin(ea) * ring_r
    tx, ty = -math.sin(ea), math.cos(ea)          # 顺时针切线
    nx, ny = math.cos(ea), math.sin(ea)           # 径向（朝外）

    head_len = HEAD_LEN * scale * SS * weight
    head_half = HEAD_HALF * scale * SS * weight
    # 底边沿切线往回退一点，让三角形根部的两个角落在弧身内侧，
    # 弧的平切端点被完全覆盖，缺口处不会露出毛刺
    bx, by = hx - tx * ring_w * 0.3, hy - ty * ring_w * 0.3

    tip = (bx + tx * head_len, by + ty * head_len)
    b1 = (bx + nx * head_half, by + ny * head_half)
    b2 = (bx - nx * head_half, by - ny * head_half)
    d.polygon([tip, b1, b2], fill=white)

    # 起笔端不再补圆头：那个圆点在缺口处会比弧身粗一圈，看起来像多余的
    # 装饰。4 倍超采样后平切边已经足够平滑。

    # 对勾
    pts = [(x * scale * SS, y * scale * SS) for x, y in CHECK_POINTS]
    lw = round(CHECK_WIDTH * scale * SS * weight)
    d.line(pts, fill=white, width=lw, joint="curve")
    for x, y in (pts[0], pts[-1], pts[1]):
        disc(d, x, y, lw / 2, white)

    fg = fg.resize((s, s), Image.LANCZOS)
    return Image.alpha_composite(canvas, fg)


def with_shadow(block: Image.Image) -> Image.Image:
    """
    给方块加一层柔和投影。

    macOS 图标自身带轻微投影，系统也会再叠一层；这里压得很克制
    （偏移小、模糊大、透明度低），避免大图标上显得脏。
    """
    size = block.size[0]
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))

    shadow_layer = Image.new("RGBA", block.size, (0, 0, 0, 0))
    shadow_layer.putalpha(block.getchannel("A").point(lambda v: round(v * 0.26)))
    shadow_layer = shadow_layer.filter(ImageFilter.GaussianBlur(max(1, round(size / 85))))
    out.paste(shadow_layer, (0, max(1, round(size / 128))), shadow_layer)
    return Image.alpha_composite(out, block)


def build_icon(size: int = SIZE, compact: bool = False) -> Image.Image:
    """
    完整图标：留白 + 方块 + 投影。

    compact=True 用于 16/32px 这类小尺寸：缩小四周留白、加粗线宽，
    否则任务栏与托盘里图形会缩成一团看不清。
    """
    if not compact:
        # 按 2 倍画方块再缩到目标尺寸，小尺寸也平滑
        work = max(size * 2, 512)
        block = build_block(work).resize((size, size), Image.LANCZOS)
        return with_shadow(block)

    # 小尺寸：直接在小画布上放大几何，不缩留白
    block = build_block(size, padding_ratio=0.04, weight=1.34)
    return with_shadow(block)


def build_tray_template(size: int = 44) -> Image.Image:
    """
    macOS 菜单栏图标：纯黑前景 + 透明背景的模板图。

    菜单栏图标和 Dock 图标是两套设计语言：
      - Dock 用 1024 的彩色圆角方块；
      - 菜单栏只有 22pt 高，必须去掉方块底板与投影，
        只保留环形箭头 + 对勾，并交给系统按亮/暗主题自动反色。

    因此这里导出的是 alpha 形状（黑色不透明 + 透明背景），
    由 Electron 的 setTemplateImage 标记给系统着色。
    尺寸取 44px 对应 22pt @2x，Retina 下不发虚。
    """
    s = size * SS
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 菜单栏图标要占满整个画布，不能沿用 Dock 图标 80% 的留白，
    # 否则在菜单栏里会显得比其他应用小一圈。
    scale = size / SIZE
    cx = cy = s / 2

    # 图形整体上移一点：对勾与箭头的重心偏下，居中反而看着靠下
    cy -= 8 * SS

    ring_r = RING_RADIUS * scale * SS * 1.32
    ring_w = RING_WIDTH * scale * SS * 1.32
    box = (cx - ring_r, cy - ring_r, cx + ring_r, cy + ring_r)
    black = (0, 0, 0, 255)

    if RING_START < RING_END:
        d.arc(box, start=RING_START, end=RING_END, fill=black, width=round(ring_w))
    else:
        d.arc(box, start=RING_START, end=360, fill=black, width=round(ring_w))
        d.arc(box, start=0, end=RING_END, fill=black, width=round(ring_w))

    sa = math.radians(RING_START)
    ea = math.radians(RING_END)
    hx, hy = cx + math.cos(ea) * ring_r, cy + math.sin(ea) * ring_r
    tx, ty = -math.sin(ea), math.cos(ea)
    nx, ny = math.cos(ea), math.sin(ea)

    head_len = HEAD_LEN * scale * SS * 1.32
    head_half = HEAD_HALF * scale * SS * 1.32
    bx, by = hx - tx * ring_w * 0.3, hy - ty * ring_w * 0.3
    tip = (bx + tx * head_len, by + ty * head_len)
    b1 = (bx + nx * head_half, by + ny * head_half)
    b2 = (bx - nx * head_half, by - ny * head_half)
    d.polygon([tip, b1, b2], fill=black)

    # 对勾同样绕 (512,512) 布局，先平移到画布中心
    pts = [
        (cx + (x - SIZE / 2) * scale * SS * 1.32, cy + (y - SIZE / 2) * scale * SS * 1.32)
        for x, y in CHECK_POINTS
    ]
    lw = round(CHECK_WIDTH * scale * SS * 1.32)
    d.line(pts, fill=black, width=lw, joint="curve")
    for x, y in (pts[0], pts[-1], pts[1]):
        disc(d, x, y, lw / 2, black)

    out = img.resize((size, size), Image.LANCZOS)
    # 图形贴边时缩采样会损失不透明度；抬一点对比度让边缘更利落
    alpha = out.getchannel("A").point(lambda v: 255 if v > 40 else v)
    out.putalpha(alpha)
    return out


def main() -> None:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    build_dir = os.path.join(root, "build")
    res_dir = os.path.join(root, "resources")
    os.makedirs(build_dir, exist_ok=True)
    os.makedirs(res_dir, exist_ok=True)

    master = build_icon(1024)

    master.save(os.path.join(build_dir, "icon.png"))
    master.resize((512, 512), Image.LANCZOS).save(os.path.join(res_dir, "icon.png"))
    # macOS 菜单栏图标：44×44 单色模板图，由系统按亮/暗主题着色
    build_tray_template(44).save(os.path.join(res_dir, "trayTemplate.png"))
    # Windows 图标：48px 以上用正常留白版，16/32px 换成加粗紧凑版。
    # 小尺寸下正常版的留白会让图形缩成一团，任务栏里几乎看不清。
    ico_sizes = [256, 128, 64, 48, 32, 16]
    ico_images = [
        master.resize((w, w), Image.LANCZOS) if w >= 48 else build_icon(w, compact=True)
        for w in ico_sizes
    ]
    ico_images[0].save(
        os.path.join(build_dir, "icon.ico"),
        format="ICO",
        sizes=[(w, w) for w in ico_sizes],
        append_images=ico_images[1:],
    )

    # macOS 图标：显式提供 icns 需要的全部尺寸，含 1024 的 @2x。
    # Pillow 直接 save 默认只写部分档位，缺 512@2x 时 Finder / Dock
    # 在大图标场景会拿小图放大，看着发虚。
    icns_sizes = [(16, 16), (32, 32), (64, 64), (128, 128), (256, 256), (512, 512), (1024, 1024)]
    try:
        master.save(
            os.path.join(build_dir, "icon.icns"),
            sizes=icns_sizes,
        )
        icns_note = "ok"
    except Exception as exc:  # noqa: BLE001
        icns_note = f"跳过（{exc}）"

    print("已生成：")
    print("  build/icon.png     1024x1024")
    print(f"  build/icon.ico     {', '.join(str(w) for w in ico_sizes)}")
    print(f"  build/icon.icns    {icns_note}")
    print("  resources/icon.png 512x512")
    print("  resources/trayTemplate.png 44x44（macOS 菜单栏，单色模板）")


if __name__ == "__main__":
    main()
