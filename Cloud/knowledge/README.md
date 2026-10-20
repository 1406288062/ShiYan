# Cloud knowledge service

Both ShiYan clients use the authenticated `/shiyan/v1/knowledge/` API. The API forwards to the cloud backend on loopback port 18770; no Mac tunnel is required.

The deployed application contains ShiYan's own `Mac/knowledge/backend` and account bridge source. `Cloud/knowledge/run_service.py` launches that same backend on Linux. Production data lives outside the application at `/home/ubuntu/shiyan-knowledge/data`: SQLite metadata, original PDFs, generated knowledge, and Chroma vectors. Never commit data, model files, credentials or environment files.

The Qwen3-Embedding-0.6B worker uses the official Q8_0 GGUF weights on loopback port 8770. Query instructions, 1024 dimensions, and L2 normalization match the original model; existing vectors are imported without recomputation. Model identity is stable across host paths via `SHIYAN_QWEN_MODEL_ID`. The local Mac PyTorch path remains available when the HTTP worker is not configured.

Install the worker and embedding user service templates only after the source, configuration, data snapshot, dependency environment, and verified model/runtime binaries are prepared. `service.env` must be private (0600). The public sidecar must authenticate each account, validate routes and forward `X-Shiyan-Owner`; the backend is never exposed publicly.

Migration acceptance: verify SQLite integrity and entity counts, hash PDFs/knowledge JSON, compare vector counts and sample embeddings, test account isolation and real retrieval/answers, then change the sidecar upstream and disable the old Mac tunnel. Retain the old Mac data as a backup until a separate cleanup is requested.
