# 拾燕项目工作说明

- 总目录：/Users/yu/codex/拾燕
- Mac 源码：Mac/；iOS 源码：iOS/ShiYan/。
- Mac 与 iOS 统一由本总目录的 Git 仓库管理；修改前检查根工作区，不清理已有未提交修改和历史数据。
- 修改文件前确认具体目标，不确定时先问。
- Mac 使用 /opt/homebrew/bin/python3；依赖已满足时不新建虚拟环境或安装依赖。
- Mac WebUI 命令：cd "/Users/yu/codex/拾燕/Mac" && /opt/homebrew/bin/python3 webui.py。
- iOS 构建使用 SHIYAN.xcodeproj / ShiYanApp；用户未要求时不打开模拟器。
- 外网访问本机失败时可通过已配置的新加坡服务器 SSH 跳板。
- 原 claude code 路径为兼容符号链接，后续开发优先使用本总目录。

## iOS 功能页控件一致性

- 新增功能页或首页按钮时，同位置、同含义的操作优先复用现有控件，不能为新页面单独另写一套外观。
- 功能页头复用 ShiyanFeatureHeader；侧栏与右侧操作控件使用 ShiyanPreviewLayout.controlDiameter（46pt），保持现有页头间距。
- 功能页的三个点“更多”菜单复用 ShiyanMoreMenu。Dots 与空间必须共用图标、字号、触控范围及玻璃背景。
- 取消或关闭复用 ShiyanCloseButton；独立功能页头使用 diameter: ShiyanPreviewLayout.controlDiameter，NavigationStack 工具栏使用 inToolbar: true，避免重复叠加玻璃层。
- 文字与图标优先使用 .primary / .secondary 等语义颜色，随深浅模式切换；保持现有系统发送按钮的尺寸和状态外观。
- Dots 首页以私人助手对话为主；任务和处理过程按需查看，不重复展示助手身份、闲置口号或实现说明。
