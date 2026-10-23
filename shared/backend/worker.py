 
from __future__ import annotations
import argparse
import json
import math
from pathlib import Path
import sys
import resource
from .limits import MAX_LOCAL_OUTPUT_PIXELS, normalized_size

def report(**fields):
    print(json.dumps({"event":"progress", **fields}, ensure_ascii=False), flush=True)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--model", choices=["general","anime"], default="general")
    args = parser.parse_args()
    import cv2
    import numpy as np
    from src.engine import ImageEnhancer
    from src.utils import load_image, save_image
    image = load_image(args.input)
    height, width = image.shape[:2]
    target_width, target_height = normalized_size(width, height)
    if (target_width, target_height) != (width, height):
        image = cv2.resize(image, (target_width, target_height), interpolation=cv2.INTER_AREA)
        width, height = target_width, target_height
    if height * width * 16 > MAX_LOCAL_OUTPUT_PIXELS:
        raise ValueError("增强结果超过可处理尺寸")
    enhancer = ImageEnhancer("x4plus_anime" if args.model == "anime" else "x4plus", scale=4, tile_size=400)
    report(progress=0, label="加载增强模型")
    enhancer._load_model()
    report(progress=0, label="正在增强", device=str(enhancer._device))
    count = math.ceil((width + (-width % 4)) / 400) * math.ceil((height + (-height % 4)) / 400)
    completed = 0
    def completed_tile(module, inputs, output):
        nonlocal completed
        completed += 1
        report(progress=min(completed / max(count,1), 0.99), label="正在增强")
    handle = enhancer._model.register_forward_hook(completed_tile)
    pixels_path = Path(str(args.output) + ".pixels")
    output = None
    try:
        output = np.memmap(pixels_path, dtype=np.uint8, mode="w+", shape=(height * 4, width * 4, 3))
        result = enhancer.enhance(image, output_buffer=output, timeout_seconds=1800)
        if result.shape[:2] != (height * 4, width * 4):
            raise ValueError("增强输出尺寸校验失败")
        output.flush()
        report(progress=0.99, label="正在保存图片")
        if not cv2.imwrite(args.output, result, [cv2.IMWRITE_JPEG_QUALITY, 92]):
            raise ValueError("无法保存增强结果")
        if not Path(args.output).is_file() or Path(args.output).stat().st_size == 0:
            raise ValueError("无法保存增强结果")
        report(progress=1, label="增强完成", output=args.output,
               width=result.shape[1], height=result.shape[0], inputWidth=width, inputHeight=height,
               peakRssBytes=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
    finally:
        handle.remove()
        if output is not None:
            output.flush()
        pixels_path.unlink(missing_ok=True)

if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"event":"error","error":str(exc)}, ensure_ascii=False), flush=True)
        sys.exit(1)
