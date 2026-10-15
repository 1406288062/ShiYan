 

import gc
import os
import sys
import time
import numpy as np
from pathlib import Path
from typing import Optional, List
from .utils import load_image, save_image, get_output_path

import torch
import torch.nn as nn
import torch.nn.functional as F

MODEL_DIR = Path(__file__).parent.parent / "models"


 
 
 

class ResidualDenseBlock(nn.Module):
     
    def __init__(self, nf: int = 64, gc: int = 32):
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
     
    def __init__(self, nf: int = 64, gc: int = 32):
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
     

 
 
 
 
    def __init__(self, num_in_ch: int = 3, num_out_ch: int = 3,
                 num_feat: int = 64, num_block: int = 23,
                 num_grow_ch: int = 32, scale: int = 4):
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
            feat = nn.functional.interpolate(feat, scale_factor=2, mode='nearest')
            feat = self.lrelu(getattr(self, f"conv_up{i}")(feat))

        out = self.conv_last(self.lrelu(self.conv_hr(feat)))
        return out


 
 
 

def _pad_to_multiple(img: torch.Tensor, multiple: int = 4):
     
    _, _, h, w = img.shape
    pad_h = (multiple - h % multiple) % multiple
    pad_w = (multiple - w % multiple) % multiple
    if pad_h == 0 and pad_w == 0:
        return img, (0, 0, 0, 0)
    return F.pad(img, (0, pad_w, 0, pad_h), mode='reflect'), (0, pad_w, 0, pad_h)


def _tile_process(model, img: torch.Tensor, tile_size: int = 400, tile_pad: int = 10, deadline: float = None,
                  output_buffer: Optional[np.ndarray] = None, timeout_seconds: Optional[float] = 120):
     
    b, c, h, w = img.shape
    if output_buffer is None and h <= tile_size and w <= tile_size:
        return model(img)

     
     
    output = (torch.zeros(b, c, h * model.scale, w * model.scale, device=img.device)
              if output_buffer is None else output_buffer)
    for y in range(0, h, tile_size):
        for x in range(0, w, tile_size):
            if deadline and time.time() > deadline:
                del output
                if torch.backends.mps.is_available():
                    torch.mps.empty_cache()
                raise TimeoutError(f"推理超时 ({int(time.time() - deadline + (timeout_seconds or 120))}s)")

            y1 = max(0, y - tile_pad)
            x1 = max(0, x - tile_pad)
            y2 = min(h, y + tile_size + tile_pad)
            x2 = min(w, x + tile_size + tile_pad)

            tile = img[:, :, y1:y2, x1:x2]
            tile_out = model(tile)

             
            out_y1 = (y - y1) * model.scale
            out_x1 = (x - x1) * model.scale
            out_y2 = out_y1 + (min(y + tile_size, h) - y) * model.scale
            out_x2 = out_x1 + (min(x + tile_size, w) - x) * model.scale

            out_y = y * model.scale
            out_x = x * model.scale
            if output_buffer is None:
                output[:, :, out_y:out_y + out_y2 - out_y1, out_x:out_x + out_x2 - out_x1] = \
                    tile_out[:, :, out_y1:out_y2, out_x1:out_x2]
            else:
                 
                 
                take_h = min(out_y2 - out_y1, output_buffer.shape[0] - out_y)
                take_w = min(out_x2 - out_x1, output_buffer.shape[1] - out_x)
                if take_h > 0 and take_w > 0:
                    cropped = tile_out[0, :, out_y1:out_y1 + take_h, out_x1:out_x1 + take_w]
                    tile_np = cropped.permute(1, 2, 0).cpu().numpy()
                    tile_np = np.clip(tile_np * 255.0, 0, 255).astype(np.uint8)
                    output_buffer[out_y:out_y + take_h, out_x:out_x + take_w] = tile_np[:, :, ::-1]
                    del cropped, tile_np
                del tile_out

    return output


 
 
 

class ImageEnhancer:
     

    MODEL_CONFIG = {
        "x2plus":       {"num_block": 23, "num_feat": 64, "scale": 2},
        "x4plus":       {"num_block": 23, "num_feat": 64, "scale": 4},
        "x4plus_anime": {"num_block": 6,  "num_feat": 64, "scale": 4},
    }

    MODEL_URLS = {
        "x2plus": [
            "https://gh-proxy.com/https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.1/RealESRGAN_x2plus.pth",
            "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.1/RealESRGAN_x2plus.pth",
        ],
        "x4plus": [
            "https://gh-proxy.com/https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth",
            "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth",
        ],
        "x4plus_anime": [
            "https://gh-proxy.com/https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.2.4/RealESRGAN_x4plus_anime_6B.pth",
            "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.2.4/RealESRGAN_x4plus_anime_6B.pth",
        ],
    }

    def __init__(self, model_name: str = "x4plus", scale: int = 4, tile_size: int = 400):
        self.model_name = model_name
        self.out_scale = scale
        self.tile_size = tile_size
        self._model = None
        self._device = None
        self._num_in_ch = 3   

    def _select_device(self) -> torch.device:
        if torch.backends.mps.is_available():
            print("🚀 使用 MPS (Apple GPU) 加速")
            return torch.device("mps")
        elif torch.cuda.is_available():
            return torch.device("cuda")
        else:
            print("⚠️  使用 CPU (慢)")
            return torch.device("cpu")

    def _load_model(self):
         
        if self._model is not None:
            return

        cfg = self.MODEL_CONFIG.get(self.model_name)
        if cfg is None:
            raise ValueError(f"未知模型: {self.model_name}。可选: {list(self.MODEL_CONFIG.keys())}")

        self._device = self._select_device()

         
        model_path = MODEL_DIR / self.MODEL_URLS[self.model_name][0].split("/")[-1]
        if not model_path.exists():
            self._download_model(model_path)

         
        state = torch.load(model_path, map_location="cpu", weights_only=True)
        if "params_ema" in state:
            state = state["params_ema"]
        elif "params" in state:
            state = state["params"]
        num_in_ch = state["conv_first.weight"].shape[1]
         
        n_ups = len(set(k.split(".")[0] for k in state if k.startswith("conv_up")))
        detected_scale = 2 ** n_ups
        self._num_in_ch = num_in_ch

         
        model = RRDBNet(
            num_in_ch=num_in_ch, num_out_ch=3,
            num_feat=cfg["num_feat"],
            num_block=cfg["num_block"],
            num_grow_ch=32,
            scale=detected_scale,
        )

        if detected_scale != cfg["scale"]:
            print(f"⚠️ 模型 scale 与配置不符: 配置={cfg['scale']}x, 实际={detected_scale}x, 以实际为准")

        model.load_state_dict(state, strict=True)
        model.to(self._device)
        model.eval()
        self._model = model
        print(f"✅ 模型就绪: {self.model_name} (输入通道: {num_in_ch})")

    def _download_model(self, path: Path):
         
        urls = self.MODEL_URLS[self.model_name]
        MODEL_DIR.mkdir(parents=True, exist_ok=True)
        print(f"📥 下载 {self.model_name} 模型...")

        import urllib.request
        from urllib.request import urlretrieve

        def _p(count, block_size, total_size):
            pct = min(int(count * block_size * 100 / total_size), 100)
            sys.stdout.write(f"\r   {pct}%")
            sys.stdout.flush()

        for i, url in enumerate(urls):
            src_name = "HF" if "huggingface" in url else "GitHub"
            print(f"   [{i+1}/{len(urls)}] {src_name}: {url}")
            try:
                urlretrieve(url, path, _p)
                size_mb = path.stat().st_size / (1024 * 1024)
                print(f"\n   ✅ 下载完成 ({size_mb:.1f} MB)")
                return
            except Exception as e:
                if path.exists():
                    path.unlink()
                if i < len(urls) - 1:
                    print(f"\n   ⚠️ {src_name} 失败, 换镜像...")
                    import time as _t
                    _t.sleep(1)
                else:
                    print(f"\n❌ 所有源均失败: {e}")
                    print(f"请手动下载到: {path}")
                    for j, u in enumerate(urls):
                        print(f"   源{j+1}: {u}")
                    raise RuntimeError(f"模型 {self.model_name} 下载失败") from e

    def enhance(self, img: np.ndarray, *, output_buffer: Optional[np.ndarray] = None,
                timeout_seconds: Optional[float] = 120) -> np.ndarray:
         

 
 
 
        if output_buffer is not None and self.out_scale in {8, 16}:
            raise ValueError("分块输出缓冲区目前支持单次模型倍率")
        if self.out_scale == 8:
            return self._enhance_8x_cascade(img)
        if self.out_scale == 16:
            return self._enhance_16x_cascade(img)
        self._load_model()

        t0 = time.time()
        if timeout_seconds is not None and timeout_seconds <= 0:
            raise ValueError("timeout_seconds 必须大于 0 或为 None")
        deadline = t0 + timeout_seconds if timeout_seconds is not None else None

        if output_buffer is not None:
            expected = (img.shape[0] * self.out_scale, img.shape[1] * self.out_scale, 3)
            if (not isinstance(output_buffer, np.ndarray) or output_buffer.dtype != np.uint8
                    or output_buffer.shape != expected or not output_buffer.flags.writeable):
                raise ValueError("输出缓冲区尺寸、类型或写入权限无效")
            if self._model.scale != self.out_scale:
                raise ValueError("分块输出缓冲区倍率必须与模型一致")

         
        rgb = img[:, :, ::-1].astype(np.float32) / 255.0
        tensor = torch.from_numpy(rgb).permute(2, 0, 1).unsqueeze(0).to(self._device)

         
        if self._num_in_ch > 3:
            extra = torch.zeros(1, self._num_in_ch - 3, tensor.shape[2], tensor.shape[3], device=self._device)
            tensor = torch.cat([tensor, extra], dim=1)

         
        tensor, pads = _pad_to_multiple(tensor, 4)

        with torch.no_grad():
            try:
                if self.tile_size > 0 or output_buffer is not None:
                    tile_size = self.tile_size if self.tile_size > 0 else max(tensor.shape[2:])
                    output = _tile_process(self._model, tensor, tile_size, deadline=deadline,
                                           output_buffer=output_buffer, timeout_seconds=timeout_seconds)
                else:
                    output = self._model(tensor)
            except TimeoutError:
                del tensor
                if torch.backends.mps.is_available():
                    torch.mps.empty_cache()
                raise

        if output_buffer is not None:
             
            elapsed = time.time() - t0
            print(f"   [{img.shape[1]}×{img.shape[0]}] → [{output_buffer.shape[1]}×{output_buffer.shape[0]}]  {elapsed:.1f}s")
            return output_buffer

         
        _, p_r, _, p_b = pads
        if p_b > 0 or p_r > 0:
            _, _, h, w = output.shape
            output = output[:, :, :h - p_b * self._model.scale, :w - p_r * self._model.scale]

         
        model_scale = self._model.scale
        h_in, w_in = img.shape[:2]
        if model_scale != self.out_scale:
            import cv2
            h_target, w_target = h_in * self.out_scale, w_in * self.out_scale
            output_np = output.squeeze(0).permute(1, 2, 0).cpu().numpy()
            output_np = np.clip(output_np * 255.0, 0, 255).astype(np.uint8)
            output_np = cv2.resize(output_np, (w_target, h_target), interpolation=cv2.INTER_LANCZOS4)
            output_np = output_np[:, :, ::-1]   
            elapsed = time.time() - t0
            print(f"   [{w_in}×{h_in}] → [{w_target}×{h_target}] (模型{model_scale}x→目标{self.out_scale}x)  {elapsed:.1f}s")
            return output_np

        h_out, w_out = h_in * self.out_scale, w_in * self.out_scale
        output = output[:, :, :h_out, :w_out]

         
        output = output.squeeze(0).permute(1, 2, 0).cpu().numpy()
        output = np.clip(output * 255.0, 0, 255).astype(np.uint8)
        output = output[:, :, ::-1]   

        elapsed = time.time() - t0
        print(f"   [{img.shape[1]}×{img.shape[0]}] → [{output.shape[1]}×{output.shape[0]}]  {elapsed:.1f}s")

        return output

    def _enhance_8x_cascade(self, img: np.ndarray) -> np.ndarray:
         
        import cv2

         
        print("📐 8x 增强: 阶段 1/2 (CNN ×4)")
        s1 = ImageEnhancer(self.model_name, scale=4, tile_size=self.tile_size)
        try:
            img_4x = s1.enhance(img)
        finally:
            del s1._model; del s1; gc.collect()
            if torch.backends.mps.is_available(): torch.mps.empty_cache()

         
        h_mid, w_mid = img.shape[0] * 2, img.shape[1] * 2
        img_mid = cv2.resize(img_4x, (w_mid, h_mid), interpolation=cv2.INTER_LANCZOS4)
        print(f"   Lanczos 缩小: [{img_4x.shape[1]}×{img_4x.shape[0]}] → [{w_mid}×{h_mid}]")

         
        print("📐 8x 增强: 阶段 2/2 (CNN ×4)")
        s2 = ImageEnhancer(self.model_name, scale=4, tile_size=self.tile_size)
        try:
            return s2.enhance(img_mid)
        finally:
            del s2._model; del s2; gc.collect()
            if torch.backends.mps.is_available(): torch.mps.empty_cache()

    def _enhance_16x_cascade(self, img: np.ndarray) -> np.ndarray:
         
        print("📐 16x 增强: 阶段 1/2 (CNN ×4)")
        s1 = ImageEnhancer(self.model_name, scale=4, tile_size=self.tile_size)
        try:
            img_4x = s1.enhance(img)
        finally:
            del s1._model; del s1; gc.collect()
            if torch.backends.mps.is_available(): torch.mps.empty_cache()

        print("📐 16x 增强: 阶段 2/2 (CNN ×4)")
        s2 = ImageEnhancer(self.model_name, scale=4, tile_size=self.tile_size)
        try:
            return s2.enhance(img_4x)
        finally:
            del s2._model; del s2; gc.collect()
            if torch.backends.mps.is_available(): torch.mps.empty_cache()

    def enhance_file(self, input_path: str, output_path: Optional[str] = None,
                     output_dir: str = "outputs") -> str:
         
        img = load_image(input_path)
        result = self.enhance(img)
        if output_path is None:
            output_path = get_output_path(input_path, output_dir, self.out_scale)
        save_image(result, output_path)
        print(f"   ✅ {output_path}")
        return output_path

    def enhance_batch(self, input_dir: str, output_dir: str = "outputs") -> List[str]:
         
        import glob

        files = []
        for ext in ["jpg", "jpeg", "png", "bmp", "webp", "JPG", "JPEG", "PNG"]:
            files.extend(glob.glob(str(Path(input_dir) / f"*.{ext}")))

        if not files:
            print(f"未找到图片: {input_dir}")
            return []

        print(f"找到 {len(files)} 张图片\n")
        results = []
        for i, f in enumerate(files):
            print(f"[{i+1}/{len(files)}] {Path(f).name}")
            try:
                results.append(self.enhance_file(f, output_dir=output_dir))
            except Exception as e:
                print(f"   ❌ 失败: {e}")

        print(f"\n完成 {len(results)}/{len(files)} 张")
        return results
