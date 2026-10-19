# 拾燕知识库

知识库前后端源码由拾燕根 Git 仓库维护，均为普通文件。

- `frontend/src/`：桌面知识库 Vue 界面；保持现有图谱展示。
- `backend/src/`：文档解析、知识结构、检索、问答、账户与权限。
- `backend/tests/`：知识库回归测试。
- `../desktop_backend/rag_service.py`：拾燕认证转接与隔离。
- `../../iOS` 不使用网页；原生页面源码位于 `iOS/ShiYan/Untitled Project/KnowledgeView.swift`（相对仓库根目录）。

桌面构建：`/opt/homebrew/bin/python3 Mac/knowledge/build_frontend.py`。
服务启动：`/opt/homebrew/bin/python3 Mac/knowledge/run_service.py --port 8769`。
前端依赖由 `frontend/package-lock.json` 固定；Python 依赖见 `backend/requirements.txt`，Node 问答适配依赖见 `backend/codex-bridge/package-lock.json`。

`.runtime/` 只保存本机依赖、模型、私有配置及知识库数据，不入 Git。
启动入口优先验证 Homebrew Python；依赖不足时使用 `.runtime/python/bin/python`。
私有配置为 `.runtime/service.env` 和 `~/.config/shiyan-rag/bridge.json`，不写入源码。
数据库、文档和向量索引位于 `.runtime/data/`，模型位于 `.runtime/models/`。
服务不读取其他项目目录，也不把其他项目目录作为工作目录。
