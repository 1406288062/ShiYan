import { spawn } from "node:child_process";

const port = 23459;
const remote = [
  "cd /Users/yu/codex &&",
  `HTTPS_PROXY='http://127.0.0.1:${port}' HTTP_PROXY='http://127.0.0.1:${port}'`,
  `https_proxy='http://127.0.0.1:${port}' http_proxy='http://127.0.0.1:${port}'`,
  "CODEX_HOME='/Users/yu/.codex'",
  "'/Users/yu/.local/bin/codex' exec --json --sandbox read-only --skip-git-repo-check",
  "--thread-source dots-runtime-test",
  "-c 'approval_policy=\"never\"'",
  "-c 'model_reasoning_effort=\"low\"'",
  "-"
].join(" ");

const args = [
  "-T", "-i", "/home/ubuntu/.ssh/mac_codex_ed25519",
  "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
  "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=8",
  "-o", "ExitOnForwardFailure=yes", "-R", `127.0.0.1:${port}:127.0.0.1:8888`,
  "yu@demacbook-air-8", remote
];

const child = spawn("/usr/bin/ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.stdin.end("Reply only MAC_PROXY_OK. Do not modify files.\n");
const timer = setTimeout(() => child.kill("SIGTERM"), 120000);
child.on("close", code => { clearTimeout(timer); process.exit(code ?? 1); });
