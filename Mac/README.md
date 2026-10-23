# 拾燕 · AI 图片增强

基于 Real-ESRGAN 的图片超分辨率增强工具，提供 Gradio 网页界面和命令行接口。支持 Apple Silicon MPS、CUDA 和 CPU 推理，并可处理 JPG、PNG、BMP、WEBP；在 macOS 上可自动转换 HEIC 图片。

## 安装

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

模型权重不会提交到仓库。首次运行时，程序会根据所选模式自动下载到 `models/` 目录；下载地址和模型配置见 [`src/engine.py`](src/engine.py)。

## 共用架构

业务源码已移到总目录的 `shared/frontend/`、`shared/backend/`、`shared/image/`。桌面入口、原生工程与打包器在 `apps/desktop/`，网页入口在 `apps/web/`，平台配置在 `config/platforms.json`。

本目录的 `web`、`desktop_backend`、`src`、`native`、`tools`、`tests`、`platforms.json` 是相对兼容链接，旧启动命令仍可使用。模型、知识库独立工程、输入输出和已有安装包位置保持原样。完整结构与开发约定见[总目录说明](../README.md#目录)。

目录迁移不改变任何平台的页面、功能或权限。下文原启动和图像处理命令继续兼容。

## 启动界面

```bash
python webui.py
```

打开 <http://127.0.0.1:7860>。

## 命令行用法

```bash
# 4 倍增强
python main.py inputs/sample.jpg -o outputs/sample_4x.jpg

# 2 倍、4 倍或 8 倍增强
python main.py photo.jpg --scale 2
python main.py photo.jpg --scale 8

# 动漫模式
python main.py anime.png --anime

# 批量处理目录
python main.py ./photos --batch -o ./enhanced
```

图片过大或显存不足时，可以调小分块大小：

```bash
python main.py photo.jpg --tile 200
```

## 项目结构

```text
main.py          # 命令行入口
webui.py         # Gradio 网页界面
src/engine.py    # RRDBNet 和推理流程
src/utils.py     # 图片读写工具
models/          # 本地模型缓存，不提交到 Git
inputs/          # 示例输入
outputs/         # 示例输出
```

模型及相关实现基于 [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN)。
