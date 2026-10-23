"""Compact local UI views. Persistent records and sync payloads retain full details."""
import hashlib
import json

KINDS = {"command_execution", "mcp_tool_call", "web_search", "file_change", "collab_tool_call", "image_generation"}

def execution_stats(message, raw):
    stored = message.get("executionStats")
    if isinstance(stored, dict) and all(type(stored.get(k)) is int and stored[k] >= 0 for k in ("total", "success", "failed", "pending")) and stored["total"] == stored["success"] + stored["failed"] + stored["pending"]:
        return stored
    projected = {i.get("id"): i for i in message.get("displayItems", []) if isinstance(i, dict)}
    source = raw if isinstance(raw, list) else message.get("displayItems", [])
    items = {}
    for i in source:
        if not isinstance(i, dict) or i.get("type") not in KINDS:
            continue
        p = projected.get(i.get("id"), {})
        items[i.get("id") or ("anonymous", len(items))] = {**p, **i, "status": i.get("status") or p.get("status")}
    stats = dict(total=len(items), success=0, failed=0, pending=0)
    for i in items.values():
        code = i.get("exit_code")
        failed = i.get("status") == "failed" or bool(i.get("error")) or (isinstance(i.get("result"), dict) and i["result"].get("isError") is True) or (i.get("type") == "command_execution" and type(code) in (int, float) and code != 0)
        success = i.get("status") in ("completed", "succeeded", "success") or (i.get("type") == "command_execution" and code == 0)
        stats["failed" if failed else "success" if success else "pending"] += 1
    return stats

def message_view(message):
    view = dict(message)
    digest = hashlib.sha256()
    deferred = message.get("executionDetailsAvailable") is True
    def files(records):
        nonlocal deferred
        if not isinstance(records, list):
            return records
        result = []
        for record in records:
            if not isinstance(record, dict):
                result.append(record)
                continue
            item = dict(record)
            diff = item.pop("diff", None)
            if diff:
                deferred = True
                digest.update(str(diff).encode())
                if item.get("available") is not False:
                    item["available"] = True
            result.append(item)
        return result
    raw = message.get("rawResult")
    parsed = raw
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except (ValueError, TypeError):
            parsed = None
    if raw:
        deferred = True
        digest.update((raw if isinstance(raw, str) else json.dumps(raw, ensure_ascii=False, separators=(",", ":"))).encode())
        view.pop("rawResult", None)
    display = message.get("displayItems")
    if not isinstance(display, list) and isinstance(parsed, list):
        display = parsed
    if isinstance(display, list):
        items = []
        for i in display:
            if not isinstance(i, dict) or i.get("type") not in KINDS:
                items.append(i)
                continue
            summary = {k: i[k] for k in ("id", "type", "status", "exit_code") if k in i}
            if i.get("error"):
                summary["error"] = True
            if isinstance(i.get("result"), dict) and i["result"].get("isError"):
                summary["result"] = {"isError": True}
            if "changes" in i:
                summary["changes"] = files(i["changes"])
            if summary != i:
                deferred = True
                digest.update(json.dumps(i, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode())
            items.append(summary)
        view["displayItems"] = items
    if "fileChanges" in message:
        view["fileChanges"] = files(message["fileChanges"])
    if deferred:
        view["executionStats"] = execution_stats(message, parsed)
        digest.update(json.dumps(view, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode())
        view["detailsDeferred"] = True
        view["detailsToken"] = digest.hexdigest()
    return view

def conversation_view(conversation):
    return {**conversation, "messages": [message_view(m) for m in conversation.get("messages", [])]}
