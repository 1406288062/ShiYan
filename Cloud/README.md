# 云端服务源码

本目录纳入拾燕云端运行时的可审查源码，与服务器部署目录对应：

- `agent-runtime/`：拾燕账户、普通会话执行、MCP 连接器、Sponge、Dots 签名网关适配器等服务源码。生产部署目录：`/home/ubuntu/boss-codex-service/shiyan-v2`。
- `dots-runtime/`：Dots 持久目标、总管、审批、通知、微信桥接和 MCP 运行时源码。生产部署目录：`/home/ubuntu/dots-runtime`。
- `knowledge/`：拾燕云端知识库服务源码（原有目录）。

## 不纳入 Git 的运行数据

`.env`、API/OAuth 凭据、设备身份文件、SQLite 数据库及 WAL、用户工作区、上传产物、运行日志/PID、`node_modules`、缓存和历史备份均继续留在服务器部署目录，不复制到仓库。依赖通过各服务的 package manifest/lockfile 安装。

## 统一 MCP 连接器

普通会话和 Dots 应共用 `agent-runtime/mcp-connectors.mjs` 的账号级连接记录及调用入口。Dots Codex 通过 `agent-runtime/mcp-connector-proxy.mjs` 转发工具发现与调用；桥接进程必须携带已认证的 owner 和 connector ID，连接器服务再次校验 owner 归属。不要为普通会话和 Dots 增加两套插件连接或独立授权开关。

部署目录与 Git 源码目录分离；更新时只同步源码，不覆盖 `data/`、`workspaces/`、`.env` 或其他运行数据。
