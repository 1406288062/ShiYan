#!/usr/bin/env python3
"""Real-ESRGAN PyTorch → Core ML 转换脚本

将 image_enhancer 项目中的 3 个 Real-ESRGAN 权重转为 Core ML .mlpackage 格式。
供 iOS App 直接调用。
"""

import sys
sys.path.insert(0, "/Users/yu/claude code/image_enhancer")

import torch
import coremltools as ct
from pathlib import Path
from src.engine import RRDBNet

MODEL_DIR = Path("/Users/yu/claude code/image_enhancer/models")
OUTPUT_DIR = Path("/Users/yu/claude code/ShiYan/ShiYan/Models")
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


def convert(model_name: str, weight_file: str, num_block: int, scale: int):
    """转换单个模型"""
    weight_path = MODEL_DIR / weight_file
    output_path = OUTPUT_DIR / f"RealESRGAN_{model_name}.mlpackage"

    print(f"\n{'='*60}")
    print(f"🔄 转换: {model_name}")
    print(f"   权重: {weight_path.name}")
    print(f"   模块数: {num_block}, 倍率: {scale}x")

    # 加载权重
    state = torch.load(weight_path, map_location="cpu", weights_only=True)
    if "params_ema" in state:
        state = state["params_ema"]
    elif "params" in state:
        state = state["params"]

    num_in_ch = state["conv_first.weight"].shape[1]

    # 自动检测真实 scale（从权重文件中的 conv_up 层数推断）
    n_ups = len(set(k.split(".")[0] for k in state if k.startswith("conv_up")))
    detected_scale = 2 ** n_ups
    if detected_scale != scale:
        print(f"   ⚠️ 配置 scale={scale}x, 权重实际 scale={detected_scale}x, 以权重为准")
        scale = detected_scale

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

    # Trace
    h = w = 128  # 小尺寸 trace，后续支持变长
    example = torch.randn(1, num_in_ch, h, w)
    with torch.no_grad():
        traced = torch.jit.trace(model, example)

    # 验证输出
    with torch.no_grad():
        out = model(example)
    print(f"   输入: {example.shape} → 输出: {out.shape} ✅")

    # 转换 Core ML
    mlmodel = ct.convert(
        traced,
        inputs=[ct.TensorType(name="image", shape=(1, num_in_ch, h, w))],
        outputs=[ct.TensorType(name="output")],
        convert_to="neuralnetwork",
        compute_units=ct.ComputeUnit.ALL,  # CPU+GPU+ANE
        minimum_deployment_target=ct.target.iOS17,
    )

    mlmodel.save(str(output_path))
    size_mb = output_path.stat().st_size / (1024 * 1024)
    print(f"   ✅ 已保存: {output_path.name} ({size_mb:.1f} MB)")


if __name__ == "__main__":
    print("🎯 Real-ESRGAN → Core ML 批量转换")
    print(f"   输出目录: {OUTPUT_DIR}")

    models = [
        # (name, weight_file, num_block, scale)
        ("x2plus",       "RealESRGAN_x2plus.pth",          23, 2),
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

    print(f"\n{'='*60}")
    print("📦 最终输出:")
    for f in sorted(OUTPUT_DIR.glob("*.mlpackage")):
        size_mb = sum(p.stat().st_size for p in f.rglob("*")) / (1024 * 1024)
        print(f"   {f.name}  ({size_mb:.1f} MB)")
