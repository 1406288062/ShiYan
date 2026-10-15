 

import cv2
import numpy as np
from PIL import Image
from pathlib import Path


def load_image(path: str) -> np.ndarray:
     
    img = cv2.imread(path, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError(f"无法读取图片: {path}")
    return img


def save_image(img: np.ndarray, path: str):
     
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(path, img)


def get_output_path(input_path: str, output_dir: str, scale: int = 4) -> str:
     
    from datetime import datetime
    p = Path(input_path)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    return str(Path(output_dir) / f"{p.stem}_{ts}_{scale}x{p.suffix}")


def pil_to_cv2(pil_img: Image.Image) -> np.ndarray:
     
    return cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGB2BGR)


def cv2_to_pil(cv2_img: np.ndarray) -> Image.Image:
     
    return Image.fromarray(cv2.cvtColor(cv2_img, cv2.COLOR_BGR2RGB))
