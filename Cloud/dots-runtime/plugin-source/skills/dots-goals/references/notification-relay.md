# Notification delivery evidence

The existing hourly scheduled ChatGPT reader is a legacy polling fallback. Its current state must be inspected before calling it enabled. It returns to its own associated conversation and does not append to arbitrary source conversations. This release does not create or modify that schedule.

Dots bridge 0.5.0 prefers a host-created, verified `goal.notification` webhook subscription. The bridge signs events, keeps durable pending outbox entries, retries failures and exposes subscription delivery status. A saved plugin release or a listed event is not evidence that a host subscribed. Verify subscription acceptance and callback challenge before claiming real-time updates.

`dots_list_notifications` and `dots_get_timeline` are durable reconnect replay APIs. `dots_ack_notifications` records per-consumer handoff after durable storage; it does not mark a human as having read a message or a phone as having displayed it. Never silently substitute replay or a scheduled reader for promised real-time delivery.

Full Shiyan source analysis and staged client integration work are recorded on the server in `SHIYAN-INTEGRATION.md`. No Shiyan UI or phone push adapter is installed by this plugin release.
