import cv2
import numpy as np
import base64

def remove_green_and_resize(input_path, output_path, target_size=60):
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

    h, w = result.shape[:2]
    min_dim = min(h, w)
    x = (w - min_dim) // 2
    y = (h - min_dim) // 2
    cropped = result[y:y+min_dim, x:x+min_dim]

    resized = cv2.resize(cropped, (target_size, target_size), interpolation=cv2.INTER_AREA)

    cv2.imwrite(output_path, resized, [cv2.IMWRITE_PNG_COMPRESSION, 6])
    print(f"成功: {output_path}, 尺寸: {resized.shape}")
    return True

def update_webui_logo(logo_path):
    with open(logo_path, 'rb') as f:
        logo_b64 = base64.b64encode(f.read()).decode('utf-8')

    with open('webui.py', 'r') as f:
        lines = f.readlines()

    for i, line in enumerate(lines):
        if '<img src="data:image/png;base64,' in line and 'alt="拾燕"' in line:
            parts = line.split('src="')
            if len(parts) >= 2:
                after_src = parts[1].split('"')[1:]
                rest = '"'.join(after_src)
                lines[i] = f'<img src="data:image/png;base64,{logo_b64}"{rest}'
                print(f"已替换第 {i+1} 行的 logo")
                break

    with open('webui.py', 'w') as f:
        f.writelines(lines)

    print("webui.py 更新完成")

if __name__ == "__main__":
    if remove_green_and_resize('logo.png', 'logo_small.png', target_size=60):
        update_webui_logo('logo_small.png')
