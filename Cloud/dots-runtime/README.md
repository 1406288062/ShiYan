# Dots Runtime

Persistent always-on agent runtime.

## Runtime
- systemd: dots-runtime.service
- local API: http://127.0.0.1:4330
- public reverse proxy: https://129.226.81.110/dots/
- data: /home/ubuntu/dots-runtime/data/dots.sqlite3
- workspaces: /home/ubuntu/dots-runtime/workspaces/<goal-id>
- secret token: /home/ubuntu/dots-runtime/.env (mode 600; never print/share it)

## Control
Run from this directory:
- ./dotsctl health
- ./dotsctl list
- ./dotsctl create "title" "instruction"
- ./dotsctl show <goal-id>
- ./dotsctl wake <goal-id> "reason"
- ./dotsctl instruct <goal-id> "new instruction"
- ./dotsctl pause <goal-id>
- ./dotsctl resume <goal-id>
- ./dotsctl cancel <goal-id>
- ./dotsctl notifications
- ./dotsctl approvals
- ./dotsctl approve <approval-id>
- ./dotsctl reject <approval-id>
- ./dotsctl timeline

## Execution model
The planner runs in a read-only Codex sandbox. Workspace mutations are executed by the runtime as explicit safe actions. Shell verification/transforms run in an isolated Docker container with no network, dropped Linux capabilities, a read-only container root, and only the goal workspace mounted read/write.

Host-level side effects are never run autonomously. They become approval requests and execute only after an explicit approval.

## Current integration state
Nginx exposes /dots/ on the existing HTTPS endpoint. The current IP certificate is self-signed, so cloud clients that require a publicly trusted CA certificate will reject it until a trusted domain/certificate is configured. Notification records and optional webhook delivery are implemented; no external Chat/Slack/Teams notification channel is configured yet.
