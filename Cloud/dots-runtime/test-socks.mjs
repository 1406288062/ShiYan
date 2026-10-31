import { spawn } from "node:child_process";

const args = [
  "-T",
  "-i", "/home/ubuntu/.ssh/mac_codex_ed25519",
  "-o", "IdentitiesOnly=yes",
  "-o", "BatchMode=yes",
  "-o", "StrictHostKeyChecking=accept-new",
  "-o", "ConnectTimeout=8",
  "-o", "ExitOnForwardFailure=yes",
  "-R", "127.0.0.1:23456",
  "yu@demacbook-air-8",
  "curl -sS --proxy socks5h://127.0.0.1:23456 -o /dev/null -w '%{http_code}\\n' --max-time 10 https://example.com/"
];
const child = spawn("/usr/bin/ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.on("close", code => process.exit(code ?? 1));
