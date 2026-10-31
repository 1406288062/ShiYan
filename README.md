# 拾燕

拾燕的 Mac 桌面端、网页端与 iOS 客户端，统一保存在本仓库中。

## 目录

```text
shared/                  # 两端业务源码，只保留一份
  frontend/              # 共用页面、样式、组件与静态资源
  backend/               # 共用接口、账户、运行时、存储与同步
  image/                 # 共用图像处理
  launcher.py            # 唯一服务启动实现
  paths.py               # 源码及应用包资源路径定位
apps/
  desktop/
    main.py              # 桌面启动入口
    native/              # 原有 macOS Swift 工程
    adapters/            # 原有 Mac Codex、Qwen TTS 实现
    tools/               # macOS 打包工具
  web/
    main.py              # 网页启动入口；差异适配按明确需求添加
config/platforms.json    # 公共配置与 desktop/web 覆盖
tests/                  # 共用回归测试
Mac/                     # 旧启动兼容入口、资源与历史集成
iOS/                    # 原 iOS 工程与辅助脚本
Cloud/                   # 云端服务源码
  shiyan-v2/             # 拾燕账号、会话执行与统一 MCP 连接器运行时
  dots-runtime/          # Dots 持久目标、总管与 MCP 桥接运行时
  knowledge/             # 云端知识库服务
```

`Mac/` 下的 `web`、`desktop_backend`、`src`、`native`、`tools`、`tests` 和 `platforms.json` 是指向新目录的相对链接，源码没有复制。原模型、知识库伴随工程、输入输出与安装包位置沿用现有路径，避免目录整理迁移用户数据或独立服务环境。

## 获取项目

    git clone https://github.com/1406288062/ShiYan.git
    cd ShiYan

仓库为私有，需要有访问权限。本次仅上传源码、界面资源和测试代码；模型文件保留在本机，不上传 GitHub。

## Mac

使用已安装依赖的 Homebrew Python；依赖列表见 Mac/requirements.txt。

    cd Mac
    /opt/homebrew/bin/python3 webui.py

原生应用构建入口为 apps/desktop/tools/build_macos_app.py（旧 Mac/tools 路径兼容）。Mac/models/ 中的模型不随仓库上传。运行图像增强时，图像处理模块会下载缺失的 Real-ESRGAN 模型；打包原生应用前需准备本地模型。

## 桌面与网页共用源码

在项目根目录启动：

    /opt/homebrew/bin/python3 apps/desktop/main.py --port 7860
    /opt/homebrew/bin/python3 apps/web/main.py --port 7860 --data-dir /path/to/existing-data

两个入口调用 `shared/launcher.py`，参数、登录、权限、界面和业务行为沿用原实现。旧的 `Mac/desktop_server.py`、`Mac/web_server.py`、`Mac/webui.py` 启动方式保留；`webui.py` 继续保留其原有 legacy 默认值。部署须显式沿用现有数据目录。

配置只维护 `config/platforms.json`：`shared` 为公共项，`desktop` 和 `web` 按键递归覆盖公共对象，数组与其他值整体替换。当前三项均为空，没有预设功能或界面差异。该配置公开给前端，不放密钥。

前端平台入口为 `shared/frontend/assets/platform.js`，提供配置查询和适配器注册。公共实现留在共享目录；只有用户明确要求的差异才增加到相应平台适配层。现有 Swift、Mac Codex 和 Qwen TTS 仅归类到桌面目录，不改变它们的调用条件或两端功能。`shared/backend/mac_codex.py` 和 `qwen_tts_worker.py` 仅保留旧导入与启动路径的兼容转发。

Python 继续使用唯一的 `desktop_backend.*`、`src.*` 导入命名；这些命名由旧路径链接定位到共享实现。不要混用 `shared.backend.*`、`shared.image.*` 加载第二套模块实例。后续仅整理包名时需要单独处理导入兼容。

在项目根目录验证：

    PYTHONPATH=Mac /opt/homebrew/bin/python3 -B -m unittest discover -s tests
    node --test tests/test_platform_frontend.mjs

本阶段只改变文件位置和路径引用，页面、菜单、功能、权限、模型选择及会话同步策略均保持原样。

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

桌面资源由原 `AIagent-project/Vue-agent` 使用 `VITE_SHIYAN_EMBEDDED=1`、base `/assets/knowledge-ui/` 构建到 `shared/frontend/assets/knowledge-ui/`。嵌入模式仅适配账户和 API 传输，不改原 Vue 模板与样式，独立 `5174` 工作台默认模式保持原样。资源在独立同源 iframe 内加载，避免拾燕工作台 CSS 影响原界面；原生上传与确认仅允许受信同源功能页。

知识处理复用本机原 Knowledge OS 工程 `/Users/yu/codex/AIagent-project/FastAPI-agent`，不复制或覆盖其数据库及模型。伴随服务 `Mac/desktop_backend/rag_service.py` 使用原工程已有 `.venv`，由 `com.shiyan.rag-bridge` 启动到本机回环地址 8769。原私人资料映射与服务凭据保存在仓库外的 `~/.config/shiyan-rag/bridge.json`（0600），不得打包进应用或提交 Git。其他拾燕账户各自隔离。

两端均通过现有拾燕账户及固定证书 HTTPS 接口 `knowledge/` 访问。云端 `knowledge-sidecar.mjs` 校验账户与请求正文 SHA256，经私有 SSH 隧道连接 Mac；隧道重连时重新检测 VPN 或 Tailscale 路线。Mac 桌面端通过 `desktop_backend/knowledge.py` 转发当前账户请求。使用知识库时，Mac 需要联网并保持唤醒。

已验证 PDF 导入、真实处理进度、内容图谱、向量与词法检索、带引用问答、历史记录和重复文档处理；iOS 验证采用 `CODE_SIGNING_ALLOWED=NO` 的通用 iOS 构建。

## 数据与历史

Git 仅管理当前源码、必要资源和测试代码。构建产物、缓存、历史验收截图、数据库、会话记录、凭据及本地备份均不上传。

本机总目录为 /Users/yu/codex/拾燕。原 claude code 下的兼容符号链接仍可使用。迁移前两个独立仓库的 Git 历史和工作区状态备份保留在本机 .backups/git-migration-20261015-230900/，不随仓库上传。
