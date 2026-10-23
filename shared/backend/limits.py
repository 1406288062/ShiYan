 
MAX_INPUT_DIMENSION = 3000
MAX_LOCAL_OUTPUT_PIXELS = 144_000_000
MAX_LOCAL_OUTPUT_BYTES = 512 * 1024 * 1024

def normalized_size(width, height):
    width, height = int(width), int(height)
    if width <= 0 or height <= 0:
        raise ValueError("图片尺寸无效")
    ratio = min(1, MAX_INPUT_DIMENSION / max(width, height))
    return max(1, round(width * ratio)), max(1, round(height * ratio))
