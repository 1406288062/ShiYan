import cv2
import numpy as np
import base64
import sys

def remove_green_background(input_path, output_path):
    img = cv2.imread(input_path)
    if img is None:
        print(f"Error: 无法读取图片 {input_path}")
        return False

    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)

    lower_green = np.array([35, 40, 40])
    upper_green = np.array([85, 255, 255])

    mask = cv2.inRange(hsv, lower_green, upper_green)

    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)

    mask = cv2.GaussianBlur(mask, (5, 5), 0)

    b, g, r = cv2.split(img)
    alpha = 255 - mask

    result = cv2.merge([b, g, r, alpha])

    cv2.imwrite(output_path, result, [cv2.IMWRITE_PNG_COMPRESSION, 3])
    print(f"成功: {output_path}")
    return True

def image_to_base64(image_path):
    with open(image_path, 'rb') as f:
        encoded = base64.b64encode(f.read()).decode('utf-8')
    return f"data:image/png;base64,{encoded}"

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("用法: python remove_green_bg.py <输入图片> <输出图片>")
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = sys.argv[2]

    if remove_green_background(input_path, output_path):
        b64 = image_to_base64(output_path)
        print("\n=== Base64 编码 (用于webui.py) ===")
        print(b64)
        print("\n=== 使用方法 ===")
        print(f"将 webui.py 中第212行的 img src 替换为上面的 base64 编码")
