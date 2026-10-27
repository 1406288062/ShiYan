# 网页端右侧工作区适配

这组修改只由 `apps/web/main.py` 在 web 模式注册。`shared/`、`apps/desktop/`、`Mac/`、iOS 源码和已安装桌面应用均不需要修改。`config/platforms.json` 仅开启 web 配置的右侧工作区。

## 实现范围

- 复用现有桌面文件树、搜索、代码选择编辑器、保存、变更卡片和执行过程组件。网页端隐藏浏览器、终端、临时聊天等入口。
- 文件面板增加当前账号的设备/项目选择；设备项目独立保存在当前账号的 `webRemoteProjects` 设置中，不写入左侧服务器项目列表。
- 通过现有海绵宝宝已连接设备执行固定文件操作。Mac 的“选择目录”使用现有工具调用系统选择框，无需更新海绵宝宝客户端或桌面应用；也支持填写目录路径。
- 文本编辑沿用原弹窗和保存按钮；校验内容版本，保留编码、换行、BOM 和权限，原子保存并备份。相同保存请求的回执只返回结果，不重复写入。
- 点击聊天生成文件，在同一个文件面板内预览 PDF、DOCX，并可下载原文件。DOCX 使用随代码分发且固定版本的 JSZip/docx-preview，不向第三方上传文档。支持图片、表格、页眉页脚及分页；复杂字体、浮动对象和精确分页仍以 Word 原件为准。旧 `.doc` 不在新增排版预览范围内。

## 海绵宝宝连接

Web 后端复用既有 owner-scoped Unix socket 协议，不需要修改或部署海绵宝宝服务：

1. 优先读取服务端环境变量 `SHIYAN_SPONGE_SOCKET`。
2. 否则读取 `SHIYAN_ROOT/data/sponge/connector.sock`。
3. 两项均未设置时，使用现有服务默认路径 `/home/ubuntu/boss-codex-service/shiyan-v2/data/sponge/connector.sock`。

部署时 Web 服务的运行用户需要拥有该 socket 的既有访问权限。Mac 单独启动开发 Web 服务器时，需要通过受信连接提供可达的 socket 路径；本次没有创建隧道、修改线上服务或部署。连接不可达时显示明确错误，不退回读取 Web 服务器宿主目录。

请求账号从已验证会话取得，不接受浏览器提交 owner、令牌、socket 地址或命令。设备归属由已有海绵宝宝服务校验。文件读写限定于选定项目目录，拒绝路径越界和符号链接穿透。所有新增业务接口沿用现有登录、同源和 CSRF 校验。

备份、保存回执和大文本暂存放在设备当前系统用户的 `~/.local/state/shiyan-web/<项目路径哈希>/` 私有目录，避免混入项目的 Git 变更。移除网页中的项目关联不会删除设备文件。

文本预览和编辑上限为 2 MiB；远端 PDF/DOCX 传输采用有界大小，超限提示下载/本机查看。任务结果待返回时只查询既有 call_id/PID，不重新执行原保存操作；结果不确定时明确提示。

DOCX 预览在不授予 same-origin 的 sandbox 中运行，脚本使用固定内容哈希 CSP，禁止网络请求、嵌套页面、表单及外链跳转。预览不会放宽主应用安全策略。

## 本地验收

全部使用临时账号、临时项目和独立测试端口，不依赖真实聊天数据，不启动/修改已安装桌面应用：

```sh
/opt/homebrew/bin/python3 -m unittest discover -s apps/web/tests -p 'test_*.py' -v
node --test apps/web/tests/workspace.test.mjs tests/test_change_cards.mjs tests/test_platform_frontend.mjs tests/test_web_browser_repair.mjs
/opt/homebrew/bin/python3 apps/web/tests/smoke_docx_browser.py
/opt/homebrew/bin/python3 apps/web/tests/smoke_workspace_browser.py
```

完整交互测试使用真实 FastAPI 登录/会话中间件、真实浏览器、模拟的 owner-scoped MCP socket，以及实际固定设备文件脚本操作临时文件；不是直接伪造文件读取或保存结果。线上海绵宝宝网络路径和部署账号权限仍需在正式发布时验收。本次不提交、不 push、不部署。

## 撤回范围

只撤回本次 `apps/web/` 新增适配/测试与 web 入口修改，以及 `config/platforms.json` 中 web 的 `rightWorkspace` 设置。不要使用全仓库 reset/clean，以免覆盖已有未提交文件。既有用户目录、会话、模型和其他未提交内容不在撤回范围内。
