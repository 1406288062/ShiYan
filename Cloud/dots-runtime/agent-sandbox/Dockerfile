# Dots agent sandbox: one long-lived container per account. Agent SDK processes (Claude Code CLI,
# Codex app-server) run INSIDE it with their full built-in tools; the workspace and the agent home
# (sessions, caches) are bind-mounted from the host so sessions survive container restarts.
# The agent binaries are mounted read-only from the host at /opt/shiyan (not baked in), so updating
# Claude Code or Codex on the host never needs an image rebuild.
#
# Build on the server:  sudo docker build -t shiyan-agent:1 /home/ubuntu/dots-runtime/agent-sandbox
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 TZ=Asia/Shanghai
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget git jq ripgrep fd-find unzip zip xz-utils less procps tzdata \
      python3 python3-pip python3-venv python3-dev build-essential pkg-config \
      sqlite3 imagemagick poppler-utils pandoc fonts-noto-cjk \
    && ln -sf /usr/bin/fdfind /usr/local/bin/fd \
    && rm -rf /var/lib/apt/lists/*

# Common data/document tooling the agents reach for; anything else they install into their own home.
RUN pip3 install --no-cache-dir --break-system-packages \
      requests httpx beautifulsoup4 lxml pandas openpyxl python-docx python-pptx pypdf matplotlib pillow pyyaml

# The agent runs as the host service user's uid/gid (passed with --user), HOME=/home/agent.
RUN mkdir -p /home/agent /workspace /opt/shiyan /run/shiyan && chmod 1777 /home/agent /workspace /run/shiyan
ENV HOME=/home/agent PATH=/home/agent/.local/bin:/opt/shiyan/bin:/usr/local/bin:/usr/bin:/bin \
    PIP_USER=1 PIP_BREAK_SYSTEM_PACKAGES=1 npm_config_prefix=/home/agent/.local
WORKDIR /workspace
CMD ["sleep", "infinity"]
