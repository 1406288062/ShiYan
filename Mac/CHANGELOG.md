# 拾燕 Changelog

## 2026-06-27

### 新增
- PWA 支持：iPhone Safari 添加到主屏幕，全屏运行，带 App 图标
- 品牌形象：燕子衔照片 Logo + "拾燕" 名称
- 液态玻璃效果：图片上传区和结果区毛玻璃质感

### 优化
- UI 重新设计：Apple 风格浅色主题，简约大气
- 标题左对齐，副标题移到底部白线上方
- 按钮悬停深浅变化
- 图片区标签隐藏，画面更干净
- 项目精简：删除 6 个未使用源码文件 + 10 个未使用模型 + 3 个备份文件
- 模型从 5.2GB 降到 145MB
- requirements.txt 清理未使用依赖

### 修复
- `_tile_process` 死代码 bug（raise 后 tile 处理代码缩进错误导致永不被执行）
- `toggle_btn` 预估时间参数从隐式 `mode.value` 改为显式传参

### 移除
- 去水印功能（InpaintRemover + LaMa）
- 动漫风格迁移（AnimeStyler + SD 1.5）
- 人脸修复（FaceRestorer + GFP-GAN）
- 背景移除（BackgroundRemover + U²-Net）

### 文字
- "增强" 全部替换为 "AI"
- "深度卷积网络" → "深度卷积神经网络"
