#!/usr/bin/env python3
 

import argparse
from pathlib import Path
from src.engine import ImageEnhancer


def main():
    ap = argparse.ArgumentParser(
        description="🖼️  基于 Real-ESRGAN 的图片超分辨率增强工具",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  python main.py photo.jpg                          # 4x 增强
  python main.py photo.jpg -o result.jpg            # 指定输出
  python main.py photo.jpg --scale 2                # 2x 增强
  python main.py photo.jpg --scale 8                # 8x 增强 (4x→2x 级联)
  python main.py photo.jpg --anime                  # 动漫增强
  python main.py ./photos --batch -o ./enhanced     # 批量处理
        """,
    )

    ap.add_argument("input", help="输入图片路径或目录")
    ap.add_argument("-o", "--output", help="输出路径 (默认 outputs/)")
    ap.add_argument("--scale", type=int, default=4, choices=[2, 4, 8], help="超分倍率 (2/4/8, 默认 4)")
    ap.add_argument("--anime", action="store_true", help="动漫模式")
    ap.add_argument("--tile", type=int, default=400, help="分块大小 (默认 400, GPU 显存不够时调小)")
    ap.add_argument("--batch", action="store_true", help="批量处理目录")
    args = ap.parse_args()

    if args.anime:
        model = "x4plus_anime"
    else:
        model = "x4plus"
    enhancer = ImageEnhancer(model_name=model, scale=args.scale, tile_size=args.tile)

    input_path = Path(args.input)

    if args.batch or input_path.is_dir():
        output_dir = args.output or "outputs"
        enhancer.enhance_batch(str(input_path), output_dir)
    else:
        output_path = args.output or None
        result = enhancer.enhance_file(str(input_path), output_path)
        print(f"\n✅ 输出: {result}")


if __name__ == "__main__":
    main()
