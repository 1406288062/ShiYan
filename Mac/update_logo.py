import base64

with open('logo_no_bg.png', 'rb') as f:
    logo_b64 = base64.b64encode(f.read()).decode('utf-8')

with open('webui.py', 'r') as f:
    content = f.read()

old_img_line = content.split('\n')[211]
new_img_line = old_img_line.split('src="')[0] + f'src="data:image/png;base64,{logo_b64}"' + old_img_line.split('" width=')[1]

lines = content.split('\n')
lines[211] = new_img_line

with open('webui.py', 'w') as f:
    f.write('\n'.join(lines))

print("Logo 已更新")
