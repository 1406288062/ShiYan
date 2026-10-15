#!/usr/bin/env python3
 

import gc
import os
import resource
import subprocess
import sys
import tempfile

 
 
 
MEM_LIMIT_GB = 12
MEM_LIMIT_BYTES = MEM_LIMIT_GB * 1024**3
try:
    resource.setrlimit(resource.RLIMIT_AS, (MEM_LIMIT_BYTES, MEM_LIMIT_BYTES))
    print(f"🛡️  内存限制: {MEM_LIMIT_GB}GB")
except ValueError:
    print(f"⚠️  内存限制设置失败，继续运行")
except resource.error:
    print(f"⚠️  内存限制设置失败，继续运行")
from pathlib import Path
import gradio as gr
import numpy as np
import torch
import cv2
from src.engine import ImageEnhancer
from src.utils import pil_to_cv2

LOGO_PATH = Path(__file__).resolve().parent / "logo.png"

 
_original_preprocess = gr.components.image.Image.preprocess
def _patched_preprocess(self, payload):
     
     
    path = None
    if isinstance(payload, dict):
        path = payload.get("path", "")
    elif hasattr(payload, "path"):
        path = payload.path
    if path and path.lower().endswith(".heic"):
        jpg_path = tempfile.mktemp(suffix=".jpg")
        subprocess.run(["sips", "-s", "format", "jpeg", path, "--out", jpg_path],
                       check=True, capture_output=True)
        print(f"[HEIC] sips: {path} → {jpg_path}")
        if isinstance(payload, dict):
            payload = {**payload, "path": jpg_path}
        else:
            payload.path = jpg_path
    try:
        return _original_preprocess(self, payload)
    except Exception as e:
        print(f"[HEIC] fallback on error: {e}")
        if path:
            return path
        raise
gr.components.image.Image.preprocess = _patched_preprocess


FORMAT_MAP = {
    ".jpg": "JPEG", ".jpeg": "JPEG",
    ".png": "PNG",
    ".bmp": "BMP",
    ".webp": "WEBP",
}


def enhance(image, mode, scale):
     
    if image is None:
        return None, ""

     
    orig_stem = "enhanced"
    if image is None:
        return None, ""
    elif isinstance(image, dict):
         
        input_path = image["path"]
    elif isinstance(image, str):
        input_path = image
    elif isinstance(image, np.ndarray):
        input_path = None
        img = cv2.cvtColor(image, cv2.COLOR_RGB2BGR)
        ext = ".png"
    else:
        input_path = None
        img = pil_to_cv2(image)
        ext = ".png"

    if input_path is not None:
        orig_stem = Path(input_path).stem
        ext = Path(input_path).suffix.lower()
         
        if ext == ".heic":
            jpg_path = tempfile.mktemp(suffix=".jpg")
            subprocess.run(["sips", "-s", "format", "jpeg", input_path, "--out", jpg_path],
                           check=True, capture_output=True)
            input_path = jpg_path
            ext = ".jpg"
        img = cv2.imread(input_path)

    fmt = FORMAT_MAP.get(ext, "PNG")

     
    h, w = img.shape[:2]
    sc = int(scale)

     
    tiles = max(1, (h + 399) // 400) * max(1, (w + 399) // 400)
    is_anime = mode == "动漫AI"
    blocks = 6 if is_anime else 23
    per_tile = 0.6 + blocks * (0.10 if blocks == 23 else 0.03) + tiles * 0.006

    def _stage_est(t, p): return t * p

    if sc == 16:
        est = _stage_est(tiles, per_tile) + _stage_est(tiles * 16, per_tile)
    elif sc == 8:
        est = _stage_est(tiles, per_tile) + _stage_est(tiles * 4, per_tile)
    else:
        est = tiles * per_tile

    if est > 110:
        raise gr.Error(f"预计耗时 {est:.0f}s，超过 120s 限制。请缩小图片或降低倍率。")

    model_name = "x4plus_anime" if is_anime else "x4plus"
    enhancer = ImageEnhancer(model_name=model_name, scale=sc)
    try:
        import time as _time
        _t0 = _time.time()
        result = enhancer.enhance(img)
        _elapsed = _time.time() - _t0

        from datetime import datetime
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        anime_tag = "_anime" if mode == "动漫AI" else ""
        filename = f"{orig_stem}_{ts}_{scale}x{anime_tag}{ext}"
        out_path = os.path.join(tempfile.gettempdir(), filename)
        cv2.imwrite(out_path, result, [cv2.IMWRITE_JPEG_QUALITY, 92] if ext in (".jpg", ".jpeg") else [])
        print(f"已保存: {out_path} ({fmt})")
        actual_html = f"<div style='min-height:24px'>⏱ 实际耗时 {_elapsed:.0f}s</div>"
        return out_path, actual_html
    except TimeoutError:
        raise gr.Error("推理超时 (120秒)，图片过大请缩小后重试或降低倍率")
    finally:
        del enhancer._model
        del enhancer
        if torch.backends.mps.is_available():
            torch.mps.empty_cache()
        gc.collect()


 

with gr.Blocks(title="拾燕 · AI图片增强") as demo:
    gr.HTML("""
    <style>
        html, body { overflow: hidden !important; }
        /* ── 页面背景微纹理 ── */
        body {
            background-image: radial-gradient(ellipse at 50% 0%, rgba(0,113,227,0.04) 0%, transparent 60%) !important;
        }
        /* ── 图片区 — 液态玻璃 ── */
        #input-image, #output-image {
            background: rgba(255,255,255,0.55) !important;
            backdrop-filter: blur(20px) saturate(180%) !important;
            -webkit-backdrop-filter: blur(20px) saturate(180%) !important;
            border: 1px solid rgba(255,255,255,0.7) !important;
            border-radius: 16px !important;
            overflow: hidden !important;
            box-shadow:
                0 4px 16px rgba(0,0,0,0.04),
                0 1px 3px rgba(0,0,0,0.05),
                inset 0 1px 0 rgba(255,255,255,0.6) !important;
        }
        #input-image label, #output-image label {
            display: none !important;
        }
        /* ── 暗色模式适配 ── */
        .dark #title-text,
        .dark-mode #title-text {
            color: #f5f0e8 !important;
        }
        .gradio-container { --block-gap: 0px !important; --section-gap: 0px !important; }
        .gradio-container > div { gap: 0px !important; }
    </style>

    <div style="text-align:left;padding:4px 0 0 0;margin-bottom:-16px;">
        <div style="display:flex;align-items:center;gap:10px;height:32px;">
            <img src="/pwa_icon?v=20260915-transparent2" alt="拾燕" style="display:block;width:32px;height:32px;object-fit:contain;background:transparent;border-radius:0;">
            <h1 id="title-text" style="font-size:26px;line-height:32px;font-weight:600;margin:0;color:#1d1d1f;letter-spacing:0.02em;">
                拾燕
            </h1>
        </div>
    </div>
    """)

    with gr.Row():
        with gr.Column(scale=1):
            input_img = gr.Image(label="上传图片", type="filepath", height=330, elem_id="input-image")

             
            def _fix_heic_preview(img_path):
                if img_path and img_path.lower().endswith(".heic"):
                    jpg_path = tempfile.mktemp(suffix=".jpg")
                    subprocess.run(["sips", "-s", "format", "jpeg", img_path, "--out", jpg_path],
                                   check=True, capture_output=True)
                    return jpg_path
                return img_path

            input_img.upload(fn=_fix_heic_preview, inputs=input_img, outputs=input_img, api_name=False)
            with gr.Row():
                mode = gr.Radio(
                    ["通用AI", "动漫AI"],
                    value="通用AI",
                    label="AI 模式",
                )
                scale = gr.Radio(
                    [4, 8, 16],
                    value=4,
                    label="超分倍率",
                )
            with gr.Row():
                btn = gr.Button("开始处理", variant="primary", size="lg", interactive=False)
                cancel_btn = gr.Button("停止", variant="stop", size="lg")

            with gr.Row():
                est_label = gr.HTML("<div style='min-height:24px'></div>")
                actual_label = gr.HTML("<div style='min-height:24px'></div>")

            def _calc_est(img, mdl, sc):
                if img is None:
                    return "<div style='min-height:24px'></div>"
                h, w = img.shape[:2] if hasattr(img, 'shape') else (0, 0)
                if h == 0 and w == 0 and isinstance(img, str):
                    import cv2
                    im = cv2.imread(img)
                    if im is not None:
                        h, w = im.shape[:2]
                if h > 0 and w > 0:
                    tiles = max(1, (h + 399) // 400) * max(1, (w + 399) // 400)
                    blocks = 6 if mdl == "动漫AI" else 23
                    per_tile = 0.6 + blocks * (0.10 if blocks == 23 else 0.03) + tiles * 0.006
                    def _stage_est(t, p): return t * p
                    sc_int = int(sc) if sc else 4
                    if sc_int == 16:
                        est = _stage_est(tiles, per_tile) + _stage_est(tiles * 16, per_tile)
                    elif sc_int == 8:
                        est = _stage_est(tiles, per_tile) + _stage_est(tiles * 4, per_tile)
                    else:
                        est = tiles * per_tile
                    ok = "⚠️ 可能超时" if est > 110 else "✅"
                    return f"<div style='min-height:24px'>📐 {w}&times;{h} | 预估 ~{est:.0f}s {ok}</div>"
                return "<div style='min-height:24px'></div>"

            def toggle_btn(img, mdl, sc):
                if img is None:
                    return [gr.Button(interactive=False), None, "", ""]
                return [gr.Button(interactive=True), gr.skip(), _calc_est(img, mdl, sc), gr.skip()]

        with gr.Column(scale=1):
            clear_btn = gr.Button("✕", size="sm", render=False)
            output_img = gr.Image(label="AI 结果", type="filepath", height=330, buttons=["download", "fullscreen", clear_btn], elem_id="output-image")

    def _clear_all():
        return None, ""

    clear_btn.click(fn=_clear_all, inputs=None, outputs=[output_img, actual_label])
    input_img.change(fn=toggle_btn, inputs=[input_img, mode, scale], outputs=[btn, output_img, est_label, actual_label])
    mode.change(fn=_calc_est, inputs=[input_img, mode, scale], outputs=est_label)
    scale.change(fn=_calc_est, inputs=[input_img, mode, scale], outputs=est_label)

    evt = btn.click(
        fn=enhance,
        inputs=[input_img, mode, scale],
        outputs=[output_img, actual_label],
        show_progress_on=[output_img],
    )

    cancel_btn.click(fn=None, inputs=None, outputs=None, cancels=[evt])

    gr.HTML("""
    <div style="text-align:center;padding:0 0 4px 0;">
        <span style="color:#86868b;font-size:12px;">
            基于 Real-ESRGAN 深度卷积神经网络 · Apple M4 加速 · 让照片从此告别"座机拍的"
        </span>
        <br>
        <span style="color:#d4a843;font-size:11px;">
            建议上传 ≤ 2000px 的图片
        </span>
    </div>
    <style>
        footer { border-top: 1px solid #e5e5ea !important; padding-top: 8px !important; }
    </style>
    """)

PWA_HEAD = '''
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="拾燕">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<link rel="apple-touch-icon" href="/pwa_icon/180?v=20260915-transparent2">
<link rel="manifest" href="/manifest.json?v=20260915-transparent2">
<link rel="icon" type="image/png" href="/pwa_icon/64?v=20260915-transparent2">
'''

if __name__ == "__main__":
    demo.launch(server_name="0.0.0.0", server_port=7860, share=False, inbrowser=False,
                favicon_path=LOGO_PATH,
                head=PWA_HEAD,
                theme=gr.themes.Soft().set(
                    body_background_fill="#f5f5f7",
                    background_fill_primary="#f5f5f7",
                    background_fill_secondary="#ffffff",
                    block_background_fill="#ffffff",
                    block_border_color="transparent",
                    block_border_width="0px",
                    block_radius="16px",
                    input_background_fill="#ffffff",
                    input_border_color="#e5e5ea",
                    input_radius="10px",
                    color_accent="#0071e3",
                    button_primary_background_fill="#0071e3",
                    button_primary_background_fill_hover="#0058b3",
                    button_primary_border_color="transparent",
                    button_primary_text_color="#ffffff",
                    button_cancel_background_fill="#ffffff",
                    button_cancel_background_fill_hover="#f5f5f7",
                    button_cancel_text_color="#dc2626",
                    button_cancel_border_color="#e5e5ea",
                    button_large_radius="10px",
                    button_large_text_size="15px",
                ))
