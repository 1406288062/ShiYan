#!/usr/bin/env python3
"""粉底白燕 APP 图标 — 长翅深叉尾燕子剪影"""
from PIL import Image, ImageDraw, ImageFilter
import os, math

SIZE = 1024
PINK  = (255, 107, 138)
DPINK = (220, 80, 110)
WHITE = (255, 255, 255)

def draw_swallow(draw, cx, cy, s, fill):
    """绘制燕子侧身飞行剪影"""
    pts = [
        # 上喙
        (cx-250*s, cy-155*s), (cx-205*s, cy-125*s),
        # 下喙
        (cx-225*s, cy-110*s), (cx-200*s, cy-105*s),
    ]
    draw.polygon(pts, fill=fill)

    # 身体、翅、尾 — 用贝塞尔曲线逼近的多边形
    body = [
        # 头顶
        (cx-200*s, cy-105*s),
        (cx-150*s, cy-105*s), (cx-90*s, cy-155*s),
        (cx-50*s, cy-140*s),
        # 上翅前缘
        (cx+0*s, cy-190*s), (cx+80*s, cy-240*s),
        (cx+120*s, cy-240*s),
        # 翅尖
        (cx+170*s, cy-240*s), (cx+230*s, cy-210*s),
        (cx+260*s, cy-200*s),
        # 上翅后缘
        (cx+240*s, cy-180*s), (cx+180*s, cy-130*s),
        (cx+110*s, cy-80*s), (cx+70*s, cy-50*s),
        # 下翅弧
        (cx+40*s, cy-40*s),
        (cx+80*s, cy-20*s), (cx+40*s, cy-10*s),
        # 上尾叉 — 向外上翘
        (cx+100*s, cy+20*s), (cx+160*s, cy+30*s),
        (cx+230*s, cy+50*s), (cx+260*s, cy+80*s),
        (cx+230*s, cy+110*s),
        # 尾叉内部
        (cx+170*s, cy+70*s), (cx+130*s, cy+50*s),
        (cx+100*s, cy+40*s),
        # 下尾叉 — 更长更尖
        (cx+150*s, cy+80*s), (cx+190*s, cy+110*s),
        (cx+210*s, cy+130*s),
        (cx+200*s, cy+120*s), (cx+180*s, cy+100*s),
        # 回到尾根 → 腹部 → 胸
        (cx+130*s, cy+90*s), (cx+60*s, cy+60*s),
        (cx-40*s, cy-20*s),
        (cx-100*s, cy-50*s), (cx-140*s, cy-70*s),
        (cx-180*s, cy-80*s),
        # 胸 → 喉
        (cx-200*s, cy-90*s), (cx-220*s, cy-130*s),
        (cx-250*s, cy-155*s),
    ]
    # 平滑：取每隔3个点
    smooth = [body[0]]
    for i in range(1, len(body)-1):
        if i % 2 == 0:
            smooth.append(body[i])
    smooth.append(body[-1])
    draw.polygon(smooth, fill=fill)

    # 下翅（独立小块，增加层次）
    lower_wing = [
        (cx+40*s, cy-40*s),
        (cx+90*s, cy-10*s),
        (cx+180*s, cy+10*s),
        (cx+150*s, cy+40*s),
        (cx+80*s, cy+20*s),
    ]
    draw.polygon(lower_wing, fill=fill)

for color, name in [(PINK, "icon_1024.png"), (DPINK, "icon_dark_1024.png")]:
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    r = SIZE // 5
    draw.rounded_rectangle([0, 0, SIZE-1, SIZE-1], radius=r, fill=color)
    draw_swallow(draw, SIZE//2, SIZE//2+40, SIZE/600, WHITE)

    out = f"/Users/yu/claude code/ShiYan/ShiYan1/Untitled Project/Assets.xcassets/AppIcon.appiconset/{name}"
    os.makedirs(os.path.dirname(out), exist_ok=True)
    img.save(out, "PNG")
    print(f"✅ {name}")

print("✅ 图标全部生成完成")
