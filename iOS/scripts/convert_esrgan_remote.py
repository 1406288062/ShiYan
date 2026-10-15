#!/usr/bin/env python3
"""Real-ESRGAN → Core ML 转换 (在新加坡服务器运行)

自包含脚本，不依赖 image_enhancer 项目。
模型权重直接从 GitHub/HF 下载。
"""

import torch
import torch.nn as nn
import torch.nn.functional as F
import numpy as np
from pathlib import Path
import sys

# ══════════════════════════════════════════
# RRDBNet 架构 (从 engine.py 复制)
# ══════════════════════════════════════════

class ResidualDenseBlock(nn.Module):
    def __init__(self, nf=64, gc=32):
        super().__init__()
        self.conv1 = nn.Conv2d(nf, gc, 3, 1, 1)
        self.conv2 = nn.Conv2d(nf + gc, gc, 3, 1, 1)
        self.conv3 = nn.Conv2d(nf + 2 * gc, gc, 3, 1, 1)
        self.conv4 = nn.Conv2d(nf + 3 * gc, gc, 3, 1, 1)
        self.conv5 = nn.Conv2d(nf + 4 * gc, nf, 3, 1, 1)
        self.lrelu = nn.LeakyReLU(0.2, inplace=True)

    def forward(self, x):
        x1 = self.lrelu(self.conv1(x))
        x2 = self.lrelu(self.conv2(torch.cat((x, x1), 1)))
        x3 = self.lrelu(self.conv3(torch.cat((x, x1, x2), 1)))
        x4 = self.lrelu(self.conv4(torch.cat((x, x1, x2, x3), 1)))
        x5 = self.conv5(torch.cat((x, x1, x2, x3, x4), 1))
        return x5 * 0.2 + x


class RRDB(nn.Module):
    def __init__(self, nf=64, gc=32):
        super().__init__()
        self.rdb1 = ResidualDenseBlock(nf, gc)
        self.rdb2 = ResidualDenseBlock(nf, gc)
        self.rdb3 = ResidualDenseBlock(nf, gc)

    def forward(self, x):
        out = self.rdb1(x)
        out = self.rdb2(out)
        out = self.rdb3(out)
        return out * 0.2 + x


class RRDBNet(nn.Module):
    def __init__(self, num_in_ch=3, num_out_ch=3, num_feat=64, num_block=23,
                 num_grow_ch=32, scale=4):
        super().__init__()
        self.scale = scale
        self.conv_first = nn.Conv2d(num_in_ch, num_feat, 3, 1, 1)
        self.body = nn.ModuleList([RRDB(num_feat, num_grow_ch) for _ in range(num_block)])
        self.conv_body = nn.Conv2d(num_feat, num_feat, 3, 1, 1)
        for i in range(int(np.log2(scale))):
            setattr(self, f"conv_up{i+1}", nn.Conv2d(num_feat, num_feat, 3, 1, 1))
        self.conv_hr = nn.Conv2d(num_feat, num_feat, 3, 1, 1)
        self.conv_last = nn.Conv2d(num_feat, num_out_ch, 3, 1, 1)
        self.lrelu = nn.LeakyReLU(0.2, inplace=True)

    def forward(self, x):
        feat = self.conv_first(x)
        body_feat = feat.clone()
        for block in self.body:
            body_feat = block(body_feat)
        body_feat = self.conv_body(body_feat)
        feat = feat + body_feat
        n_ups = int(np.log2(self.scale))
        for i in range(1, n_ups + 1):
            feat = F.interpolate(feat, scale_factor=2, mode='nearest')
            feat = self.lrelu(getattr(self, f"conv_up{i}")(feat))
        out = self.conv_last(self.lrelu(self.conv_hr(feat)))
        return out


# ══════════════════════════════════════════
# 转换函数
# ══════════════════════════════════════════

MODEL_URLS = {
    "x4plus": [
        "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth",
        "https://gh-proxy.com/https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth",
    ],
    "x2plus": [
        "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.1/RealESRGAN_x2plus.pth",
        "https://gh-proxy.com/https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.1/RealESRGAN_x2plus.pth",
    ],
    "x4plus_anime": [
        "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.2.4/RealESRGAN_x4plus_anime_6B.pth",
        "https://gh-proxy.com/https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.2.4/RealESRGAN_x4plus_anime_6B.pth",
    ],
}

MODEL_CONFIG = {
    "x4plus":       {"num_block": 23, "scale": 4},
    "x2plus":       {"num_block": 23, "scale": 2},
    "x4plus_anime": {"num_block": 6,  "scale": 4},
}

OUTPUT_DIR = Path("./output_models")
OUTPUT_DIR.mkdir(exist_ok=True)


def download(urls, path):
    import urllib.request
    from urllib.request import urlretrieve
    path.parent.mkdir(parents=True, exist_ok=True)
    for i, url in enumerate(urls):
        try:
            print(f"   [{i+1}] {url[:80]}...")
            urlretrieve(url, path)
            print(f"   ✅ {path.stat().st_size / 1024 / 1024:.1f} MB")
            return
        except Exception as e:
            print(f"   ⚠️ 失败: {e}")
    raise RuntimeError(f"All URLs failed for {path}")


def convert_model(name):
    import coremltools as ct

    cfg = MODEL_CONFIG[name]
    out_path = OUTPUT_DIR / f"RealESRGAN_{name}.mlpackage"
    weight_path = Path(f"./{name}.pth")

    # 下载
    if not weight_path.exists():
        print(f"📥 下载 {name}...")
        download(MODEL_URLS[name], weight_path)

    # 加载权重
    state = torch.load(weight_path, map_location="cpu", weights_only=True)
    if "params_ema" in state:
        state = state["params_ema"]
    elif "params" in state:
        state = state["params"]

    num_in_ch = state["conv_first.weight"].shape[1]
    n_ups = len(set(k.split(".")[0] for k in state if k.startswith("conv_up")))
    detected_scale = 2 ** n_ups
    if detected_scale != cfg["scale"]:
        print(f"   ⚠️ scale 修正: {cfg['scale']}x → {detected_scale}x")
        cfg["scale"] = detected_scale

    # 构建模型
    model = RRDBNet(
        num_in_ch=num_in_ch, num_out_ch=3, num_feat=64,
        num_block=cfg["num_block"], scale=cfg["scale"],
    )
    model.load_state_dict(state, strict=True)
    model.eval()
    print(f"   ✅ 模型加载成功 (输入通道: {num_in_ch})")

    # Trace
    h = w = 128
    example = torch.randn(1, num_in_ch, h, w)
    with torch.no_grad():
        traced = torch.jit.trace(model, example)
        out = model(example)
    print(f"   输入: {example.shape} → 输出: {out.shape}")

    # 转换 Core ML
    print(f"🔄 Core ML 转换中...")
    mlmodel = ct.convert(
        traced,
        inputs=[ct.TensorType(name="image", shape=(1, num_in_ch, h, w))],
        outputs=[ct.TensorType(name="output")],
        convert_to="mlprogram",
        compute_units=ct.ComputeUnit.ALL,
        minimum_deployment_target=ct.target.iOS17,
    )
    mlmodel.save(str(out_path))
    print(f"   ✅ {out_path.name}")


if __name__ == "__main__":
    to_convert = sys.argv[1:] or ["x4plus", "x4plus_anime", "x2plus"]
    print(f"🎯 转换: {to_convert}\n")

    for name in to_convert:
        try:
            convert_model(name)
        except Exception as e:
            print(f"   ❌ {name}: {e}")
            import traceback
            traceback.print_exc()

    print(f"\n📦 结果:")
    for f in sorted(OUTPUT_DIR.glob("*.mlpackage")):
        size_mb = sum(p.stat().st_size for p in f.rglob("*")) / 1024 / 1024
        print(f"   {f.name} ({size_mb:.1f} MB)")
