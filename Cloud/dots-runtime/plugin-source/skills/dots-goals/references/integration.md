# Dots bridge 0.5.0 / plugin 0.2.0

## Tools

The existing endpoint exposes 14 tools: create/get/list goals, instruct/control a goal, get timeline, list/read outputs, list/ack notifications, list/decide approvals, notification status and capability discovery. The tools use `securitySchemes: [{type: "noauth"}]` plus the `_meta` mirror. The secret endpoint path remains the private capability; no account or audience changes are made.

Initialization negotiates the requested supported standard MCP version. Event-capable hosts can use 2026-07-28 with the existing goal.notification subscription protocol; older standard hosts get tools without a claim of native event support.

## Session contract

`client_context` is `{host, conversation_id}`, where host is chatgpt/shiyan_desktop/shiyan_mobile/other. It records the originating conversation. It is not the internal Codex thread ID and never authorizes another owner. All devices viewing one goal retain the original context.

Use `request_id` for create/instruct retry deduplication. It is 1-128 characters matching `[A-Za-z0-9][A-Za-z0-9._:-]*`. Reusing it with different payload, operation or conversation fails instead of creating another task. The runtime preserves goal and Mac Codex threads across continuation.

## Notifications

Verified webhook subscriptions enqueue durable outbox entries with stable event IDs. Failed attempts do not mark delivery; pending entries survive a runtime restart and retry with bounded backoff. HTTP 410 disables a subscription; attempts are bounded and exhausted records remain inspectable. This is at-least-once delivery, so hosts deduplicate by event ID.

Ordered `dots_list_notifications(after_id, limit, consumer_id)` can replay durable missed notifications. Client ACK advances only that consumer's cursor after durable handoff, not human receipt, global read state or webhook acceptance. Choose an independent consumer per conversation/device/scope. `dots_get_timeline` supplies ordered progress replay. Neither installs a UI listener or replaces an unavailable real-time subscription.

## Shiyan scope

Current Shiyan desktop WebView/Python and iOS SwiftUI clients have no Dots session type or sidebar entry. Their device-signed gateway and synchronization model need a goal/conversation mapping before these tools appear as a dedicated conversation. Native phone notifications need additional OS push integration. The plugin update does not modify those clients.

The current runtime is single owner. Model/effort selection, per-goal token budgets, artifact file browsing and arbitrary multi-user sharing are not added by this release. Control stops future actions while already running Codex/OS operations may finish.
