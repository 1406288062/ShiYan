# Dots 与拾燕集成及当前架构

## 2026-10-12 总管架构更新（当前）

服务器 `dots-runtime.service` 已上线 v0.6.0，签名网关 `shiyan-dots.service` 已上线总管接口。每个私人 owner 对应唯一持久总管，默认主会话由总管回复，原 goals 作为任务及历史保留。生产迁移核对：25 个旧目标的 ID、状态、线程、运行次数和唤醒时间逐项保持一致；没有启动旧暂停、已完成或待审批任务。

总管对话和协调使用独立通道，执行池最多两个 worker。子任务有依赖和验收状态，完成报告需要总管验收。SQLite 保存输入回执、历史消息、偏好笔记、运行租约、控制版本、动作凭证和资源锁。暂停、取消、新指令和幂等重放分别处理；重复请求不会中断正在运行的总管回合。审批绑定具体命令与控制版本，取消后旧审批不可执行。结果不明时保留锁，先核查，避免盲目重试。Mac 实际操作通过 Yu Remote Commander 优先执行，备用 SSH 同样查询或启动唯一远程 operation，路由切换保留线程；模型网络代理与命令通道分开。

主入口为 `GET /shiyan/v1/dots/manager`、`POST /manager/messages`、`POST /manager/control`、`GET /manager/activity`、`GET /manager/messages?before=&limit=`。公开路径仍复用设备签名和现有 owner 认证，私有 Dots URL、令牌和签名密钥不进入两端。总管活动先持久补拉，再通过既有 SSE 向客户端回放；活跃客户端补拉间隔 2 秒。`activityCursor` 防止晚到快照覆盖新消息和任务状态，ACK 仅在客户端实际收到并落盘后推进。原 goal 的签名 webhook 保留，总管没有原生 webhook；APNs、硬预算和固定重复计划尚未实现，能力接口明确返回 false。

MCP 工具从 14 个增至 20 个，新增 `dots_get_manager`、`dots_message_manager`、`dots_control_manager`、`dots_get_manager_activity`、`dots_get_manager_messages`、`dots_reconcile_action`，原有工具保留兼容。官方参考采用 [Dots 任务与记忆](https://learn.chatgpt.com/docs/dots/tasks-and-memory)、[Dots 控制](https://learn.chatgpt.com/docs/dots/controls) 和 [Agents as tools 编排](https://developers.openai.com/api/docs/guides/agents/orchestration)。本项目是自建运行时，具体数据库和调度实现属于本项目工程方案。

桌面与 iOS 源码已改为单总管对话，任务/历史按需打开，手机处理过程默认折叠，支持历史消息分页、可靠待发记录和独立事件游标。iOS 最终工程无签名编译成功；本轮签名构建被登录钥匙串私钥访问 `errSecInternalComponent` 阻止，尚未安装本轮新版。桌面新版已安装并重新打开，源码、待部署包与已安装资源哈希一致，deep strict 签名验证通过，原身份 helper 保持原字节。当前真实签名联通在 HTTP 前被钥匙串阻止；只读系统检查 OSStatus=0、unlocked=false，原设备身份项仍存在，需要本地重新解锁登录钥匙串后复核。

验证：服务器 76 项与网关 39 项自动检查通过；真实隔离 SDK 联调完成两个同时运行的子任务，跨来源追加查询未创建重复任务，结果均验收并汇总。真实 Mac 唯一 operation 返回 `MAC_MANAGER_PIPELINE_OK`，模型启动阶段曾发生路由重试，最终退出码 0。原生客户端源码、编译和恢复验证在 native QA 中记录，不能把 unsigned 编译或模拟输入当成手机实机联通证据。

记录位于服务器 `shiyan-v2/qa/dots-manager-20261012/` 与 `shiyan-v2/qa/dots-manager-native-20261012/`；部署前 SQLite 在线快照和迁移比对均已保存。

## 2026-10-12 早先接入更新（历史）

拾燕签名网关已部署独立 `shiyan-dots.service`，公开业务路径为 `/shiyan/v1/dots/`，通过服务器私有 Unix MCP socket 调用 Dots。创建、追加要求、目标控制、审批、输出、签名通知和 SSE 补拉已实现；设备身份和所有者归属复用现有拾燕认证。

已导入当前私人账号的 23 个原有目标并验证 23 个通知订阅，未改变目标状态或重建线程。服务端隔离测试 17 项通过；两端源码已增加 Dots 页面、持久请求记录、独立接收游标及审批命令预览。桌面最终客户端已安装并通过 14 项 Mac 接口、35 项浏览器及 8 项 SQLite 重启检查；原生签名连接已创建验收目标 25，重复提交返回同一 ID，目标保持暂停。iOS 原生模型与状态测试 33 项通过、设备目标 unsigned 编译通过；用户已报告解锁 Mac 登录钥匙串，但签名构建仍报 errSecInternalComponent，GUI 签名探针结果因 Mac 连接中断待核对。iOS 新版本尚未安装，两端实机联通验收尚未通过。

手机 APNs 系统推送尚未实现。前台通过事件流接收，重新打开时按持久游标补拉。设备 ACK 只确认入库，不代表用户已读。

以下内容保留为接入前分析与后续阶段参考；其中“当前未实现客户端/网关”的描述对应早先的分析时间。

分析日期：2026-10-12。范围：Mac 上桌面及手机源码、服务器现有接口，以及本轮 Dots 插件契约。Mac 检查通过 Yu Remote Commander 完成，仅只读查看；未修改拾燕、未创建业务目标、未运行目标。本文不包含私有 MCP 路径、访问令牌或 webhook 签名密钥。

## 结论与本轮范围

拾燕已经有普通聊天、跨端同步、流式任务观察和断线恢复，可以作为后续界面基础；目前没有 Dots 专用导航、目标会话模型或系统推送注册。本轮只调整 Dots 插件，补齐工具发现、目标控制、来源会话绑定和可靠通知交接，不改变两套拾燕客户端，也不修改拾燕服务器。

完整产品需要三层共同实现：Dots 负责持久目标和执行；拾燕签名网关负责身份、路由和跨端归属；桌面与手机负责导航、会话、操作控件和用户可见通知。MCP 接入成功只能证明插件工具可被调用，不能证明拾燕 UI 已接入或手机收到推送。

## 已查验的 Mac 现状

| 部分 | 源码 / 安装位置 | 现有实现与缺口 |
| --- | --- | --- |
| 桌面源码 | `/Users/yu/claude code/image_enhancer` | Swift AppKit + WKWebView 外壳，内置 Python/FastAPI 后端及 SQLite；无 Dots 功能 |
| 已安装桌面 | `/Users/yu/Applications/拾燕.app` | 版本 2.2.0，bundle ID 为 `com.shiyan.image-enhancer.desktop`；检查时 App 与后端均运行 |
| 手机源码 | `/Users/yu/claude code/ShiYan/ShiYan/Untitled Project` | SwiftUI 聊天与本地持久化；会话模型只有普通 job/thread，没有 Dots goal 映射 |
| Mac Dots 实验 | `/Users/yu/codex/dots-realtime-smoke/dots_cli.py` | 独立 CLI：签名 webhook 接收、订阅 `goal.notification`、追加指令和读取结果；未接入拾燕界面 |

安装包的 `web/app.js`、`web/assets/workbench.js` 以及 `desktop_backend/{gateway,runtime,sync,api}.py` 与源码 SHA256 一致。桌面 SQLite 只读检查发现 assets、conversations、history、photoJobs、projects、temporaryConversations 文档种类，没有 goals；未读取用户聊天内容。

桌面真正的“新聊天”按钮由 `web/assets/workbench.js:82` 放到侧栏标题后；随后是置顶、项目、最近。后续 Dots 导航可以插在这两个区域之间。手机导航在 `AgentSidebar.swift`，聊天与新聊天行为在 `AIAgentView.swift`。`AgentModels.swift` 的 `AgentConversation` 没有 `goalID` 或专用会话类型，需要后续显式扩展。

桌面 `desktop_backend/gateway.py` 和手机 `CodexClient.swift` 均通过拾燕 `/shiyan/v1/` 网关访问云端；手机使用证书固定和 `AgentIdentity` 设备签名。桌面数据存储在 `~/Library/Application Support/image_enhancer/state.sqlite3`，手机会话与同步游标在自己的应用目录。

现有通知和同步的边界：

- 桌面 `/api/events` 是本地状态快照 SSE；云端普通 job 的事件有序号及补拉，桌面关闭后本地观察停止。
- 手机 `AgentSync.swift` 约每 4 秒同步项目、会话和消息；后台观察时间到期后取消本地观察。持久自主执行应继续留在服务器。
- 手机保留未知 `syncMetadata`，但桌面 `desktop_backend/sync.py:13` 的种类及字段白名单不会保留新加的 goal 字段；不能只给手机模型加字段便认为跨端已完成。
- 主动源码未发现 APNs、`registerForRemoteNotifications` 或 `UNUserNotificationCenter` 注册。本轮不提供系统推送或通知跳转 UI。

## 已查验的服务器现状

Dots 位于 `/home/ubuntu/dots-runtime`。分析时实际运行的是独立启动的 `server.mjs` 进程，原 `dots-runtime.service` 与 `dots-core.service` 均 inactive。最终部署已启动服务器原有的 `dots-runtime.service`，由 systemd 自动保活；该服务原本已启用开机启动。旧版 dots-core 未启动。`server.mjs` 持有 SQLite 目标、输入事件、时间线、审批和输出；调度器在服务器上继续目标，不依赖聊天页面或 Mac App 保持打开。工作区按 goal 隔离，现有执行器和持久 thread 不因客户端接入而重建。

当前实现包含持久目标、定时唤醒、输出记录、人工审批及 Mac 执行相关代码。它提供的是现有 Dots 行为，并非对 ChatGPT Dots 内部系统的完整复刻；单次执行结果、持续目标状态、消息交接和用户可见显示需要分别验证。

拾燕服务器位于 `/home/ubuntu/boss-codex-service/shiyan-v2`：

- `device-auth.mjs` 负责设备登记及签名认证。
- `sync-sidecar.mjs` 提供现有 `/v1/sync` 与附件同步，按 owner 归属数据。
- `sync-store.mjs` 的 `KINDS` 目前只接受 projects、conversations、messages；会话字段白名单没有 Dots goal 映射。
- 现有同步物化读取普通 job/conversation 状态，不读取 Dots 目标与通知。本轮不修改这些文件。

历史 `MESSAGE-RETURN.md` 记录了按小时读取通知的 ChatGPT relay，它不等于实时事件推送，也不能追加到任意来源聊天。新 webhook outbox 与独立 consumer ACK 不能被表述为这条历史路径已经端到端升级成功。

## 阶段一：本轮 Dots 插件基础

当前契约以 `mcp-contract.mjs`、`mcp-events.mjs` 与 `goal-run-state.mjs` 为准。下面记录接口能力；实际公网发布和集成验证应以本轮部署结果为准。

### MCP 发现与认证声明

`initialize` 对客户端请求进行版本协商，支持 `2024-11-05`、`2025-03-26`、`2025-06-18`、`2025-11-25`、`2026-07-28`；未知版本回退到 `2025-06-18`。标准版本声明 tools 能力；新 events 版本另外声明 events 能力。不要对标准客户端固定返回更高版本或要求它支持扩展 events。

14 个工具同时在工具级 `securitySchemes` 和 `_meta.securitySchemes` 声明 `noauth`。这里表示宿主无需 OAuth 握手；私有 MCP URL 本身仍包含访问能力，不能公开分享或嵌入客户端构建。`client_context` 是来源路由信息，不能代替身份认证，也不是多用户授权边界。

| 工具 | 作用 |
| --- | --- |
| `dots_create_goal` | 创建持久目标，可绑定来源会话；`run_now=false` 创建暂停目标 |
| `dots_get_goal` | 查询目标、状态、时间线、审批和输出引用 |
| `dots_list_goals` | 按状态及来源会话过滤，带数量限制 |
| `dots_instruct_goal` | 为已有目标追加指令，复用目标与订阅 |
| `dots_control_goal` | pause、resume、cancel、wake |
| `dots_get_timeline` | 按 `after_id` 补拉目标持久进度记录，返回 next_cursor/has_more；不等于实时投递 |
| `dots_list_outputs` | 目标输出引用列表 |
| `dots_read_output` | 读取一个已存储输出的完整内容和摘要 |
| `dots_list_notifications` | 顺序读取持久通知，支持 `after_id`、来源/目标过滤与 consumer 游标 |
| `dots_ack_notifications` | 仅确认指定 consumer 已持久接收；幂等推进其游标 |
| `dots_list_approvals` | 列出待审请求及具体命令 |
| `dots_decide_approval` | 明确用户同意后批准或拒绝；批准要求原样的 `confirmed_command` |
| `dots_notification_status` | 查询订阅有效期、webhook 结果和 outbox 状态；不返回回调地址或密钥 |
| `dots_get_capabilities` | 返回协议、工具、单所有者模型、通知能力与客户端尚未接入的状态 |

### 来源会话与目标控制

```json
{
  "client_context": {
    "host": "shiyan_desktop",
    "conversation_id": "stable-conversation-id"
  }
}
```

`host` 可为 chatgpt、shiyan_desktop、shiyan_mobile、other；`conversation_id` 应使用宿主持久保存的会话标识。创建目标时绑定，目标查询、列表及通知可以返回该映射。现有未绑定目标仍保留，不通过重新创建目标迁移。

创建目标与追加指令支持可选的 `request_id`，对应服务器持久幂等请求记录。宿主应在提交前保存请求 ID，并在超时重试时复用同一 ID 和相同内容；不同业务操作或修改后的指令使用新 ID。省略该字段不提供断线重复提交保护；请求幂等也不代表外部副作用已经被用户确认或实现严格一次执行。

插件当前仅按创建来源精确过滤：同一拾燕会话在另一端出现时，不应盲目改用另一个 host 过滤导致目标“消失”。后续签名网关需要维护统一的 owner/conversation → goal 归属，并保留真实创建来源；当前 client_context 不是跨端同步系统。

已暂停目标必须显式 resume 后再追加指令或 wake；resume 只针对 paused/blocked，waiting_approval 应走审批流程。done/cancelled 是终态，不能借 instruct/wake/resume 重启。运行中收到 pause/cancel 时，异步回合写回前读取最新状态，避免旧结果把目标重新置为 active，后续动作也需检查目标是否仍 active。

暂停或取消阻止后续步骤；已经运行的 Codex 回合或操作系统命令仍可能完成。界面不能承诺“所有当前命令已立即终止”。

### 持久通知、ACK 与 webhook

通知读取与确认分开：`dots_list_notifications` 不确认、不投递、不标记用户已读。省略 `after_id` 时可使用该 `consumer_id` 的已确认游标，显式 `after_id` 用于重新补拉。返回 `next_cursor` 和 `has_more`，consumer ACK 只推进该 consumer 的游标，不修改其他设备或用户的读取状态。

宿主应该先把一批通知持久化，再 ACK 到该批安全处理完成的最后通知 ID。ACK 是累计游标；如果复用同一个 consumer 对多个目标分别过滤，确认较高 ID 可能跳过尚未接收的较低 ID。宿主应为不同读取范围使用不同 consumer，或采用统一通知流并在本地路由，不能混用范围。

Webhook 使用经过验证的宿主 HTTPS 回调，签名校验、事件去重及持久 outbox 支持失败重试。事件订阅为 `goal.notification`，当前订阅参数按 goal ID 或全局范围选择。创建目标本身不产生真实回调地址，不能由模型捏造地址或宣称实时投递已完成。

三个确认必须分别记录：Dots 已生成通知、webhook 接收端已接受、目标会话已持久显示/用户已读。webhook 2xx 或 ACK 只能证明交接，不证明用户看到了消息。

### 当前基础仍未实现的部分

- 无每目标 token 预算、预算计量/硬停止、模型或推理档位控制工具；不能把插件参数不存在的控制项承诺成已完成。
- 无产物目录浏览、任意文件下载或文件树接口。当前 `dots_read_output` 读取数据库输出，不等于浏览目标工作区文件。
- 幂等键目前覆盖创建与追加指令，客户端尚未接入；不能无请求 ID 盲目重试，也不能把所有控制、审批或外部命令自动视为已有完整幂等保护。
- `dots_list_goals` 当前来源读取上限为最近 200 个目标，带 limit/has_more，但不是完整的历史游标分页；输出列表也只提供数量限制。大量历史浏览需要后续扩展。
- 无拾燕适配器、客户端界面、APNs、推送权限申请或跨端目标同步。本轮不更改现有目标的预算、模型和执行权限。

## 阶段二：后续拾燕签名网关与同步模型

此阶段是后续工作，不在本轮修改范围。

1. 在现有设备签名认证后增加 Dots adapter。由服务器持有私有 MCP 访问配置并将通过认证的设备/owner 映射到目标；客户端不直接持有私有 URL 或 Dots 内部 bearer 配置。
2. 明确一个专用会话类型和稳定目标映射，推荐 owner + conversation ID + goal ID；保留来源 host 和创建时间。定义跨端续聊追加到同一目标的规则，网络切换不创建新 thread。
3. 同时扩展服务器 `sync-store.mjs`、桌面 `sync.py` 与手机模型/同步映射；使用版本化字段及迁移，保留旧普通聊天，避免现有白名单丢字段。
4. 状态由 Dots 服务器权威维护，客户端同步元数据及通知引用。保存通知来源 ID、结果引用和独立已读状态；设备 ACK 不作为全局已读。
5. 接入已提供的创建/指令 `request_id`；按需要扩展审批及其他操作的幂等保护与明确错误码。先验证超时重试、两端同时操作、旧终态复写和断线恢复，再接界面。

## 阶段三：后续桌面与 iOS 导航和会话

桌面在 `web/assets/workbench.js` 的新聊天下添加 Dots 入口，使用独立目标列表/会话视图；通过本地 FastAPI adapter 接入签名网关。手机在 `AgentSidebar.swift` 增加相同入口，通过新的 Dots client/store 展示目标。两端都不应把持续目标降级为一次普通 `/jobs` 请求。

基本界面需要：目标标题及指令、实际状态和最近活动、已有输出、追加指令、暂停/恢复/取消，以及明确的审批命令预览。预算、模型选择、文件树只有在对应后端能力实现后才能展示为可操作控件。新目标创建和追加指令的错误必须保留草稿，不能清除用户内容后再发现网络失败。

跨端验收至少覆盖：桌面创建后手机看到同一 goal，手机追加后桌面收到结果，重启任一客户端后补拉通知，暂停状态不会被正在完成的旧回合覆盖，取消目标不会被续聊隐式重启。

## 阶段四：后续可靠用户推送

前台先接可靠补拉：宿主回调接收、验签、去重、持久入库、按会话路由；桌面可复用本地 SSE，手机可以前台补拉并持久保存 consumer 游标。宿主成功入库后才返回 webhook 接受并执行 ACK。

手机关闭后的系统推送需要另外实现 APNs 服务端发送、设备 token 登记/刷新/失效处理、应用推送权限和点击通知跳转。后台静默推送不保证送达，仍应在前台恢复时按游标补拉。桌面系统通知需要独立的通知权限及目标会话跳转，当前本地 EventSource 不等于系统通知。

最终验收应独立记录：目标实际执行、通知入库、webhook 交接、会话显示、系统推送、用户读取；不得只用服务器日志或一次 2xx 证明整个链路完成。

## 后续可选增强

在基础接入稳定后，可分开实现：按目标 token/费用/时长预算及硬停止、可选模型与推理档位、完整历史分页、受控产物列表和下载、执行目标设备选择、自动唤醒策略。每项都需要对应的真实后端计量/权限/终止语义，不先在 UI 放一个没有实际作用的选项。
