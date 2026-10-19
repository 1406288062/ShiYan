# 拾燕

拾燕的 Mac 桌面端与 iOS 客户端，统一保存在本仓库中。

## 目录

- Mac/：桌面端原生外壳、Web 界面、Python 后端、图像处理模块与模型。
- iOS/ShiYan/：iOS 客户端、分享扩展、Xcode 工程及 Core ML 模型。
- iOS/scripts/：模型转换和图标处理脚本。

## 获取项目

    git clone https://github.com/1406288062/ShiYan.git
    cd ShiYan

仓库为私有，需要有访问权限。本次仅上传源码、界面资源和测试代码；模型文件保留在本机，不上传 GitHub。

## Mac

使用已安装依赖的 Homebrew Python；依赖列表见 Mac/requirements.txt。

    cd Mac
    /opt/homebrew/bin/python3 webui.py

原生应用构建入口为 Mac/tools/build_macos_app.py。Mac/models/ 中的模型不随仓库上传。运行图像增强时，图像处理模块会下载缺失的 Real-ESRGAN 模型；打包原生应用前需准备本地模型。

## iOS

使用 Xcode 打开 iOS/ShiYan/SHIYAN.xcodeproj，选择 ShiYanApp Scheme。设备运行前，在 Xcode 中配置自己的签名团队。

    cd iOS/ShiYan
    xcodebuild -project SHIYAN.xcodeproj -scheme ShiYanApp -configuration Debug -destination 'generic/platform=iOS' -jobs 2 build

iOS 的 Core ML 模型不随仓库上传。构建和运行图像增强前，请从本机备份恢复以下两个模型包到 iOS/ShiYan/Untitled Project/Models/：

- RealESRGAN_x4plus.mlpackage
- RealESRGAN_x4plus_anime.mlpackage

本机现有模型保持原样，也可参考 iOS/scripts/ 中的转换脚本重新生成。

## 知识库（RAG）

Mac 左侧功能栏和 iOS 侧栏均提供“知识库”入口。同一拾燕账户共享空间、知识库、PDF 资料、内容图谱和带页码原文引用的问答历史。桌面端直接加载原 Knowledge OS 的 Vue 界面，保留原组件、配色、布局和交互；iOS 独立适配触屏布局，沿用原 RAG 视觉风格。

桌面资源由原 `AIagent-project/Vue-agent` 使用 `VITE_SHIYAN_EMBEDDED=1`、base `/assets/knowledge-ui/` 构建到 `Mac/web/assets/knowledge-ui/`。嵌入模式仅适配账户和 API 传输，不改原 Vue 模板与样式，独立 `5174` 工作台默认模式保持原样。资源在独立同源 iframe 内加载，避免拾燕工作台 CSS 影响原界面；原生上传与确认仅允许受信同源功能页。

知识处理复用本机原 Knowledge OS 工程 `/Users/yu/codex/AIagent-project/FastAPI-agent`，不复制或覆盖其数据库及模型。伴随服务 `Mac/desktop_backend/rag_service.py` 使用原工程已有 `.venv`，由 `com.shiyan.rag-bridge` 启动到本机回环地址 8769。原私人资料映射与服务凭据保存在仓库外的 `~/.config/shiyan-rag/bridge.json`（0600），不得打包进应用或提交 Git。其他拾燕账户各自隔离。

两端均通过现有拾燕账户及固定证书 HTTPS 接口 `knowledge/` 访问。云端 `knowledge-sidecar.mjs` 校验账户与请求正文 SHA256，经私有 SSH 隧道连接 Mac；隧道重连时重新检测 VPN 或 Tailscale 路线。Mac 桌面端通过 `desktop_backend/knowledge.py` 转发当前账户请求。使用知识库时，Mac 需要联网并保持唤醒。

已验证 PDF 导入、真实处理进度、内容图谱、向量与词法检索、带引用问答、历史记录和重复文档处理；iOS 验证采用 `CODE_SIGNING_ALLOWED=NO` 的通用 iOS 构建。

## 数据与历史

Git 仅管理当前源码、必要资源和测试代码。构建产物、缓存、历史验收截图、数据库、会话记录、凭据及本地备份均不上传。

本机总目录为 /Users/yu/codex/拾燕。原 claude code 下的兼容符号链接仍可使用。迁移前两个独立仓库的 Git 历史和工作区状态备份保留在本机 .backups/git-migration-20261015-230900/，不随仓库上传。
