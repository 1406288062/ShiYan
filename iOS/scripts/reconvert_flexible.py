#!/usr/bin/env python3
"""Real-ESRGAN 4x 模型 → Core ML（灵活尺寸版）

修复：原模型被 trace 为固定 128×128 输入，大图片推理全黑。
改用 RangeDim 让模型接受任意 16-4096px 的输入。
"""

import sys
sys.path.insert(0, "/Users/yu/claude code/image_enhancer")

import torch
import coremltools as ct
from pathlib import Path
from src.engine import RRDBNet

MODEL_DIR = Path("/Users/yu/claude code/image_enhancer/models")
OUTPUT_DIR = Path("/Users/yu/claude code/ShiYan/ShiYan1/Untitled Project/Models")
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


def convert(model_name: str, weight_file: str, num_block: int, scale: int):
    weight_path = MODEL_DIR / weight_file
    output_path = OUTPUT_DIR / f"RealESRGAN_{model_name}.mlpackage"

    print(f"\n🔄 转换: {model_name} (scale={scale}x, blocks={num_block})")

    # 加载权重
    state = torch.load(weight_path, map_location="cpu", weights_only=True)
    if "params_ema" in state:
        state = state["params_ema"]
    elif "params" in state:
        state = state["params"]

    num_in_ch = state["conv_first.weight"].shape[1]
    print(f"   输入通道: {num_in_ch}")

    # 构建模型
    model = RRDBNet(
        num_in_ch=num_in_ch,
        num_out_ch=3,
        num_feat=64,
        num_block=num_block,
        num_grow_ch=32,
        scale=scale,
    )
    model.load_state_dict(state, strict=True)
    model.eval()

    # Trace（128×128 为默认值）
    with torch.no_grad():
        traced = torch.jit.trace(model, torch.randn(1, num_in_ch, 128, 128))
        out = model(torch.randn(1, num_in_ch, 64, 64))
    print(f"   验证: 64→{out.shape[-1]} ✅")

    # 转换 Core ML — 灵活尺寸
    shape_h = ct.RangeDim(16, 4096, default=128)
    shape_w = ct.RangeDim(16, 4096, default=128)

    mlmodel = ct.convert(
        traced,
        inputs=[ct.TensorType(name="image", shape=(1, num_in_ch, shape_h, shape_w))],
        outputs=[ct.TensorType(name="output")],
        convert_to="mlprogram",
        compute_units=ct.ComputeUnit.ALL,
        minimum_deployment_target=ct.target.iOS17,
    )

    mlmodel.save(str(output_path))
    size_mb = sum(p.stat().st_size for p in Path(output_path).rglob("*")) / (1024 * 1024)
    print(f"   ✅ 已保存: {output_path.name} ({size_mb:.1f} MB)")


if __name__ == "__main__":
    print("🎯 Real-ESRGAN 4x → Core ML（灵活尺寸）")

    models = [
        ("x4plus",       "RealESRGAN_x4plus.pth",          23, 4),
        ("x4plus_anime", "RealESRGAN_x4plus_anime_6B.pth", 6,  4),
    ]

    for m in models:
        try:
            convert(*m)
        except Exception as e:
            print(f"   ❌ 转换失败: {e}")
            import traceback
            traceback.print_exc()

    print("\n📦 输出:")
    for f in sorted(OUTPUT_DIR.glob("*.mlpackage")):
        size_mb = sum(p.stat().st_size for p in f.rglob("*")) / (1024 * 1024)
        print(f"   {f.name} ({size_mb:.1f} MB)")
