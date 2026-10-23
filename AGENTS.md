# 拾燕项目工作说明

- 总目录：/Users/yu/codex/拾燕
- 共用源码：shared/；桌面入口与适配：apps/desktop/；网页入口：apps/web/；iOS 源码：iOS/ShiYan/。Mac/ 保留旧启动兼容和原资源位置。
- Mac 与 iOS 统一由本总目录的 Git 仓库管理；修改前检查根工作区，不清理已有未提交修改和历史数据。
- 修改文件前确认具体目标，不确定时先问。
- Mac 使用 /opt/homebrew/bin/python3；依赖已满足时不新建虚拟环境或安装依赖。
- Mac WebUI 命令：cd "/Users/yu/codex/拾燕/Mac" && /opt/homebrew/bin/python3 webui.py。
- iOS 构建使用 SHIYAN.xcodeproj / ShiYanApp；用户未要求时不打开模拟器。
- 外网访问本机失败时可通过已配置的新加坡服务器 SSH 跳板。
- 原 claude code 路径为兼容符号链接，后续开发优先使用本总目录。

## 桌面与网页的差异化管理

- 页面、业务、图像代码分别位于 `shared/frontend/`、`shared/backend/`、`shared/image/`，只保留一份。
- 新桌面/网页入口为 `apps/desktop/main.py`、`apps/web/main.py`，共同调用 `shared/launcher.py`；平台特有现有实现归入相应 apps 目录，新增差异必须有用户明确要求。
- 原 `Mac/web`、`desktop_backend`、`src`、`native`、`tools`、`tests`、`platforms.json` 为相对兼容链接，不在旧路径创建第二份实现或覆盖链接。
- Python 保持唯一 `desktop_backend.*`、`src.*` 导入命名，禁止同时用 `shared.backend.*` / `shared.image.*` 导入同一实现，避免重复状态与类型。
- 配置只维护 `config/platforms.json`，`shared` 为公共项，`desktop` / `web` 递归覆盖；当前均为空。配置会发给前端，不存放凭据。
- `shared/paths.py` 统一定位资源；模型、知识库独立环境、输入输出、已有安装包和会话数据不随源码目录整理搬迁。
- 功能归属、界面变化、入口隐藏和禁用由用户决定；目录调整只移动文件和修正路径，不改变原有业务、权限、模型或界面。
- 不同时改会话同步/缓存策略，不清理用户数据、模型、凭据、未提交内容；打包必须验证不依赖开发机绝对路径。

## iOS 功能页控件一致性

- 新增功能页或首页按钮时，同位置、同含义的操作优先复用现有控件，不能为新页面单独另写一套外观。
- 功能页头复用 ShiyanFeatureHeader；侧栏与右侧操作控件使用 ShiyanPreviewLayout.controlDiameter（46pt），保持现有页头间距。
- 功能页的三个点“更多”菜单复用 ShiyanMoreMenu。Dots 与空间必须共用图标、字号、触控范围及玻璃背景。
- 取消或关闭复用 ShiyanCloseButton；独立功能页头使用 diameter: ShiyanPreviewLayout.controlDiameter，NavigationStack 工具栏使用 inToolbar: true，避免重复叠加玻璃层。
- 文字与图标优先使用 .primary / .secondary 等语义颜色，随深浅模式切换；保持现有系统发送按钮的尺寸和状态外观。
- Dots 首页以私人助手对话为主；任务和处理过程按需查看，不重复展示助手身份、闲置口号或实现说明。
