# Dots message return — 2026-10-04

## Deployed transport

Dots notification -> ChatGPT scheduled task -> the scheduled task's associated conversation.
This is an hourly pull relay, NOT MCP Events/webhook delivery. It concentrates
notifications in the bridge conversation; it cannot append to arbitrary source chats.

- Reader: `notification-relay.py` (standard-library Python).
- Source: `data/dots.sqlite3`, opened read-only.
- State: `data/chatgpt-relay/current-chat.json`, atomic writes with a file lock.
- Native task: `Dots 工作汇报`, hourly, no output for an empty batch.
- Source baseline: notification 17. Acceptance Goal 13 is excluded from regular
  batches because it has a separate one-shot acceptance task.
- Existing runtime code, OpenVPN settings and pending approvals were not changed
  as part of this relay deployment.
- Private Dots plugin updated to 0.1.2. Existing endpoint and plugin identity preserved.

## Acceptance evidence

A real Dots Goal 13 generated notification 18 with body:
`消息回传验收：DOTS-RETURN-4A396542。`
The one-shot ChatGPT task was given only the server, Goal ID and read procedure;
its prompt did NOT contain this generated body or verification code.

`data/chatgpt-native-return-receipt.json` records an independent native task read
at `2026-10-04T15:21:49.820713+00:00` (23:21:49 Asia/Shanghai), notification_ids=[18].
This confirms Dots -> independently scheduled ChatGPT reader fetching worked.
It is NOT proof that ChatGPT persisted the final reply, that a notification was
pushed to iOS, or that the user saw it. Those delivery stages were not independently
observable from the available server tools at this documentation update.

## Reader semantics

`peek --consumer current-chat` returns a batch without advancing the cursor.
`ack --consumer current-chat --batch <returned digest>` records handoff to the
ChatGPT task, NOT end-user delivery. It never changes original `delivered_at`.
A failed read or unmatched ACK does not advance the cursor. Underlying Dots
messages remain available for inspection/replay. This is not exactly-once delivery.

Local isolated tests passed: read-only source, deterministic batches, repeatable
peek, invalid-ACK rejection, cursor preservation, idempotent initialization and
no false delivered_at mutation. A successful file write or task registration
must not be reported as complete end-to-end user delivery.
