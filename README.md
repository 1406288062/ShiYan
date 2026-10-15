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

## 数据与历史

Git 仅管理当前源码、必要资源和测试代码。构建产物、缓存、历史验收截图、数据库、会话记录、凭据及本地备份均不上传。

本机总目录为 /Users/yu/codex/拾燕。原 claude code 下的兼容符号链接仍可使用。迁移前两个独立仓库的 Git 历史和工作区状态备份保留在本机 .backups/git-migration-20261015-230900/，不随仓库上传。
