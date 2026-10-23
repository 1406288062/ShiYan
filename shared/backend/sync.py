
from __future__ import annotations
import asyncio
import base64
import hashlib
import json
import time
import os
from pathlib import Path
import uuid
from datetime import datetime, timezone
from .storage import now, new_id

KINDS = {"projects", "conversations", "messages", "scheduledTasks"}
CONVERSATION_KEYS = {"id", "title", "projectId", "createdAt", "updatedAt", "remoteConversationId", "threadId", "titleIsManual", "isPinned"}
MESSAGE_KEYS = {"id", "conversationId", "role", "text", "createdAt", "updatedAt", "completedAt", "state", "phase", "error", "requestId", "remoteJobId", "reasoning", "model", "requestStartedAt", "rawResult", "fileChanges", "displayItems", "usage", "executionDetailsAvailable", "executionDetailsChanged"}
SCHEDULE_KEYS = {"id", "title", "instruction", "emoji", "enabled", "repeat", "time", "timezone", "startDate", "endDate", "runLocally", "notificationMode", "newChatEachRun", "model", "reasoning", "projectId", "executorDeviceId", "status", "nextRunAt", "lastRunAt", "lastRunState", "lastError", "conversationId", "createdAt", "updatedAt", "source"}
SCHEDULE_CONFIG = SCHEDULE_KEYS - {"id", "executorDeviceId", "status", "nextRunAt", "lastRunAt", "lastRunState", "lastError", "conversationId", "createdAt", "updatedAt", "source"}
ASSET_KEYS = {"filename", "mimeType", "bytes", "sha256", "width", "height", "createdAt"}

def message_order(message):

    try:
        instant = datetime.fromisoformat(str(message.get("createdAt", "")).replace("Z", "+00:00"))
        if instant.tzinfo is None:
            instant = instant.replace(tzinfo=timezone.utc)
        timestamp = instant.timestamp()
    except (ValueError, TypeError, OverflowError):
        timestamp = 0.0
    return (timestamp, 0 if message.get("role") == "user" else 1)

def ordered_messages(messages):
    ordered = sorted(messages, key=message_order)
    users = {}
    for message in ordered:
        if message.get("role") == "user" and message.get("requestId"):
            users.setdefault(str(message["requestId"]).lower(), message["id"])
    children, linked = {}, set()
    for message in ordered:
        parent = users.get(str(message.get("requestId") or "").lower())
        if message.get("role") == "assistant" and parent:
            children.setdefault(parent, []).append(message)
            linked.add(message["id"])
    result = []
    for message in ordered:
        if message["id"] not in linked:
            result.append(message)
            result.extend(children.get(message["id"], []))
    return result

def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))

def asset_wire(asset):
    identifier = asset.get("syncAssetId") or asset.get("remoteId") or asset.get("id")
    return {"syncAssetId": identifier, "id": identifier, **{k: asset[k] for k in ASSET_KEYS if k in asset}}

def message_wire(message, conversation_id, baseline=None):
    value = {k: message[k] for k in MESSAGE_KEYS if k in message}
    if message.get("executionDetailsAvailable") is True:
        # Keep this cloud projection explicitly marked. The service restores
        # canonical fields except those explicitly produced by a local execution.
        dirty = {key for key in ("rawResult", "fileChanges", "displayItems") if key in (message.get("executionDetailsChanged") or [])}
        if dirty:
            value["executionDetailsChanged"] = sorted(dirty)
        else:
            value.pop("executionDetailsChanged", None)
        for key in ("rawResult", "fileChanges", "displayItems"):
            if key in dirty:
                value[key] = message.get(key, None if key == "rawResult" else [])
            elif baseline is not None and key in baseline:
                value[key] = baseline[key]
        if baseline is not None:
            for key, default in (("phase", ""), ("error", None)):
                if key not in baseline and value.get(key) == default:
                    value.pop(key, None)
    value.update(conversationId=conversation_id, assets=[asset_wire(a) for a in message.get("assets", []) if isinstance(a, dict)])
    return value

def merge_compact_details(message, original, incoming):
    """Keep full cached bodies, but let incoming file membership be authoritative."""
    for key in ("rawResult", "fileChanges", "displayItems"):
        if (key == "rawResult" or key not in incoming) and key in original:
            message[key] = original[key]
    if isinstance(incoming.get("fileChanges"), list):
        prior = {item.get("path"): item for item in (original.get("fileChanges") or []) if isinstance(item, dict)}
        files = []
        for item in incoming["fileChanges"]:
            previous = prior.get(item.get("path"), {}) if isinstance(item, dict) else {}
            same = isinstance(item, dict) and all(previous.get(key) == item.get(key) for key in ("path", "kind", "added", "removed", "available"))
            merged = {**previous, **item} if same else item
            if same and previous.get("diff") and not previous.get("diffTruncated") and (not item.get("diff") or item.get("diffTruncated")):
                merged["diff"] = previous["diff"]
                merged["diffTruncated"] = False
            files.append(merged)
        message["fileChanges"] = files
    if isinstance(incoming.get("displayItems"), list):
        prior = {item.get("id"): item for item in (original.get("displayItems") or []) if isinstance(item, dict)}
        message["displayItems"] = [{**prior.get(item.get("id"), {}), **item} if isinstance(item, dict) else item for item in incoming["displayItems"]]


class SyncEngine:
    def __init__(self, runtime):
        self.runtime, self.storage = runtime, runtime.storage
        self.gateway = runtime.gateway
        self.lock = asyncio.Lock()
        self.importing = False
        self.last_error = None
        self.schedule_host_registered = 0
        self.schedule_host_error = None
        self._schedule_host_task = None
        self._schedule_host_task_session = None
        self._schedule_host_session = None
        self._schedule_host_retry_at = 0
        self.schedule_host_timeout = 30
        self.schedule_host_interval = 25
        with self.storage.lock, self.storage.db:
            self.storage.db.executescript("""
            CREATE TABLE IF NOT EXISTS sync_entities(kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,base TEXT,snapshot TEXT,deleted INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(kind,id));
            CREATE TABLE IF NOT EXISTS sync_outbox(kind TEXT NOT NULL,id TEXT NOT NULL,mutation_id TEXT NOT NULL,base_revision INTEGER NOT NULL,data TEXT,deleted INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(kind,id));
            CREATE TABLE IF NOT EXISTS sync_conflicts(id INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT,entity_id TEXT,local_data TEXT,remote_data TEXT,created_at TEXT);
            CREATE TABLE IF NOT EXISTS sync_assets(id TEXT PRIMARY KEY,sha256 TEXT,local_id TEXT);
            CREATE INDEX IF NOT EXISTS sync_message_parent ON sync_entities(kind,json_extract(snapshot,'$.conversationId')) WHERE deleted=0;
            """)
            self.storage.sync_observer = self.local_changed
            # Local writes already update the durable outbox through the observer.
            # Rebuild historical sync metadata only once for this migration.
            if self.storage.setting("sync.startupRepairVersion", 0) < 2:
                self._repair_cached_output()


                for item in self.storage.list("scheduledTasks"):
                    self.local_changed("scheduledTasks", item, None)
                for item in self.storage.list("projects"):
                    self.local_changed("projects", item, None)
                for item in self.storage.list("conversations"):
                    ordered = ordered_messages(item.get("messages", []))
                    if ordered != item.get("messages", []):
                        item["messages"] = ordered
                        self.storage.put("conversations", item)
                    self.local_changed("conversations", item, None)
                self.storage.set_setting("sync.startupRepairVersion", 2)

    def _repair_cached_output(self):


        assets = {}
        for asset in self.storage.list("assets"):
            for key in (asset.get("id"), asset.get("remoteId"), asset.get("syncAssetId")):
                if key:
                    assets[key] = asset
        conversations = {}
        self.importing = True
        try:
            rows = self.storage.db.execute("SELECT id,revision,base FROM sync_entities WHERE kind='messages' AND deleted=0 AND base IS NOT NULL")
            for identifier, revision, raw in rows:
                data = json.loads(raw)
                if data.get("role") != "assistant" or not data.get("remoteJobId"):
                    continue
                parent_id = data.get("conversationId")
                if parent_id not in conversations:
                    conversations[parent_id] = self.storage.get("conversations", parent_id)
                parent = conversations[parent_id]
                original = next((m for m in (parent or {}).get("messages", []) if m["id"] == identifier), None)
                if not original or (data.get("state") not in {"completed", "failed", "cancelled", "interrupted"} and original.get("state") != "reconnecting"):
                    continue
                deletion = self.storage.db.execute("SELECT deleted FROM sync_outbox WHERE kind='messages' AND id=?", (identifier,)).fetchone()
                if deletion and deletion[0]:
                    continue
                local_assets = [assets.get(a.get("syncAssetId") or a.get("id")) for a in data.get("assets", [])]
                local = {**data, "assets": local_assets if all(local_assets) else original.get("assets", [])}
                self._import_document({"kind": "messages", "id": identifier, "revision": revision, "deleted": False, "data": data, "localData": local}, conversations=conversations)
                self.storage.db.execute("UPDATE sync_entities SET snapshot=base WHERE kind='messages' AND id=?", (identifier,))
                self.storage.db.execute("DELETE FROM sync_outbox WHERE kind='messages' AND id=?", (identifier,))
            for conversation in conversations.values():
                if conversation:
                    self.storage.put("conversations", conversation)
        finally:
            self.importing = False

    def _entity(self, kind, identifier):
        row = self.storage.db.execute("SELECT revision,base,snapshot,deleted FROM sync_entities WHERE kind=? AND id=?", (kind, identifier)).fetchone()
        return {"revision": row[0], "base": json.loads(row[1]) if row[1] else None, "snapshot": json.loads(row[2]) if row[2] else None, "deleted": bool(row[3])} if row else None

    def _record(self, kind, identifier, data, deleted=False):
        previous = self._entity(kind, identifier)

        if previous and previous["deleted"] and not deleted:
            return
        content = encoded(data) if data is not None else None
        snapshot = previous["snapshot"] if previous else None
        if kind == "messages" and snapshot:
            snapshot = message_wire(snapshot, snapshot.get("conversationId"), previous.get("base"))
        if previous and previous["deleted"] == deleted and snapshot == data:
            return
        revision = previous["revision"] if previous else 0
        self.storage.db.execute("INSERT INTO sync_entities(kind,id,revision,snapshot,deleted) VALUES(?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET snapshot=excluded.snapshot,deleted=excluded.deleted", (kind, identifier, revision, content, int(deleted)))
        self.storage.db.execute("INSERT INTO sync_outbox(kind,id,mutation_id,base_revision,data,deleted) VALUES(?,?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET mutation_id=excluded.mutation_id,base_revision=excluded.base_revision,data=excluded.data,deleted=excluded.deleted", (kind, identifier, new_id(), revision, content, int(deleted)))

    def local_changed(self, kind, value, previous):
        if self.importing or kind not in {"projects", "conversations", "scheduledTasks"}:
            return
        item = value or previous
        if not item or item.get("temporary"):
            return
        if kind == "conversations" and value and not any(m.get("role") == "user" for m in value.get("messages", [])) and not self._entity("conversations", item["id"]):
            return   
        if kind == "scheduledTasks":
            self._record(kind, item["id"], {k: item[k] for k in SCHEDULE_KEYS if k in item} if value else None, value is None)
            return
        if kind == "projects":
            data = {k: item[k] for k in {"id", "name", "createdAt", "isPinned"} if k in item}
            self._record(kind, item["id"], data if value else None, value is None)
            return
        self._record(kind, item["id"], {k: item[k] for k in CONVERSATION_KEYS if k in item} if value else None, value is None)
        current_ids = set()
        if value:
            previous_messages = {m["id"]: m for m in (previous or {}).get("messages", [])}
            changed_local_details = False
            for message in value.get("messages", []):
                current_ids.add(message["id"])
                prior = previous_messages.get(message["id"])
                if message.get("executionDetailsAvailable") is True and prior is not None:
                    dirty = {key for key in ("rawResult", "fileChanges", "displayItems") if key in (message.get("executionDetailsChanged") or []) or key in (prior.get("executionDetailsChanged") or [])}
                    dirty.update(key for key in ("rawResult", "fileChanges", "displayItems") if message.get(key) != prior.get(key))
                    if dirty and message.get("executionDetailsChanged") != sorted(dirty):
                        # A local producer may update only one full field. Keep
                        # the projection marker for all remaining preview fields.
                        message["executionDetailsChanged"] = sorted(dirty)
                        changed_local_details = True
                    for key in dirty:
                        if key not in message:
                            message[key] = None if key == "rawResult" else []
                            changed_local_details = True
                entity = self._entity("messages", message["id"])
                self._record("messages", message["id"], message_wire(message, item["id"], (entity or {}).get("base")))
            if changed_local_details:
                # Storage.put writes before its observer; persist this metadata
                # in the same transaction without notifying recursively.
                self.storage.db.execute("UPDATE documents SET data=? WHERE kind='conversations' AND id=?", (encoded(value), item["id"]))
        rows = self.storage.db.execute("SELECT id FROM sync_entities WHERE kind='messages' AND deleted=0 AND json_extract(snapshot,'$.conversationId')=?", (item["id"],)).fetchall()
        for (identifier,) in rows:
            if identifier not in current_ids:
                self._record("messages", identifier, None, True)

    def pending(self, limit=100, include_schedules=True):
        with self.storage.lock:
            rows = self.storage.db.execute("SELECT kind,id,mutation_id,base_revision,data,deleted FROM sync_outbox WHERE (? OR kind!='scheduledTasks') ORDER BY CASE kind WHEN 'projects' THEN 0 WHEN 'conversations' THEN 1 ELSE 2 END,rowid LIMIT ?", (int(include_schedules), limit)).fetchall()
            return [{"kind": r[0], "id": r[1], "mutationId": r[2], "baseRevision": r[3], "data": json.loads(r[4]) if r[4] else None, "deleted": bool(r[5])} for r in rows]

    def _lookup_asset(self, identifier):
        direct = self.storage.get("assets", identifier)
        if direct:
            return direct
        return next((a for a in self.storage.list("assets") if identifier in {a.get("syncAssetId"), a.get("remoteId")}), None)

    async def upload_assets(self, mutations):
        identifiers = {a["syncAssetId"] for m in mutations if not m["deleted"] and m["kind"] == "messages" for a in (m.get("data") or {}).get("assets", []) if a.get("syncAssetId")}
        for identifier in identifiers:
            with self.storage.lock:
                if self.storage.db.execute("SELECT 1 FROM sync_assets WHERE id=?", (identifier,)).fetchone():
                    continue
            asset = self._lookup_asset(identifier)
            if not asset:
                continue   
            if asset.get("remoteId") == identifier:


                with self.storage.lock, self.storage.db:
                    self.storage.db.execute("INSERT OR IGNORE INTO sync_assets VALUES(?,?,?)", (identifier, asset.get("sha256"), asset["id"]))
                continue
            content = await asyncio.to_thread(self.storage.asset_path(asset["id"]).read_bytes)
            await self.gateway.sync_asset_upload({"id": identifier, "filename": asset["filename"], "mimeType": asset["mimeType"], "data": base64.b64encode(content).decode()})
            with self.storage.lock, self.storage.db:
                self.storage.db.execute("INSERT OR REPLACE INTO sync_assets VALUES(?,?,?)", (identifier, hashlib.sha256(content).hexdigest(), asset["id"]))
                asset["syncAssetId"] = identifier
                self.storage.put("assets", asset)

    async def receive_asset(self, descriptor):
        identifier = descriptor.get("syncAssetId") or descriptor.get("id")
        if not identifier:
            return None
        try:
            uuid.UUID(identifier)
        except (ValueError, TypeError):
            return None
        existing = self._lookup_asset(identifier)
        if existing:
            return self.storage.public_asset(existing)
        _, headers, content = await self.gateway.sync_asset_download(identifier)
        digest = hashlib.sha256(content).hexdigest()
        expected = headers.get("x-content-sha256") or descriptor.get("sha256")
        if expected and expected != digest:
            raise ValueError("同步文件校验失败，原文件已保留")
        if not content or len(content) > 64 * 1024 * 1024:
            raise ValueError("同步文件为空或过大")
        filename = Path(str(descriptor.get("filename") or "文件")).name.replace("\x00", "")[:180]
        suffix = Path(filename).suffix.lower()
        if not suffix or len(suffix) > 12 or any(c not in ".abcdefghijklmnopqrstuvwxyz0123456789" for c in suffix):
            suffix = ".bin"
        stored = identifier + suffix
        destination = self.storage.media / stored
        temporary = self.storage.media / (new_id() + ".sync.tmp")
        try:
            with open(temporary, "xb") as stream:
                os.chmod(temporary, 0o600)
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            temporary.replace(destination)
        finally:
            temporary.unlink(missing_ok=True)
        asset = {"id": identifier, "syncAssetId": identifier, "filename": filename, "storedName": stored, "mimeType": descriptor.get("mimeType") or headers.get("content-type", "application/octet-stream").split(";")[0], "width": descriptor.get("width"), "height": descriptor.get("height"), "bytes": len(content), "sha256": digest, "createdAt": descriptor.get("createdAt") or now(), "url": f"/api/assets/{identifier}/file", "downloadUrl": f"/api/assets/{identifier}/file?download=1", "remoteId": None}
        with self.storage.lock, self.storage.db:
            self.storage.put("assets", asset)
            self.storage.db.execute("INSERT OR REPLACE INTO sync_assets VALUES(?,?,?)", (identifier, digest, identifier))
        return self.storage.public_asset(asset)

    async def _prepare_changes(self, changes):
        prepared = []
        for change in changes:
            if change.get("kind") not in KINDS:
                continue
            result = dict(change)
            if not result.get("deleted") and result["kind"] == "messages":
                data = dict(result.get("data") or {})
                data["assets"] = [a for a in [await self.receive_asset(a) for a in data.get("assets", []) if isinstance(a, dict)] if a]
                result["localData"] = data
            prepared.append(result)
        return prepared

    def _import_document(self, change, conversations=None):
        kind, identifier, deleted = change["kind"], change["id"], bool(change.get("deleted"))
        data = change.get("localData", change.get("data")) or {}
        if kind == "scheduledTasks":
            if deleted:
                self.storage.remove(kind, identifier)
                return True
            original = self.storage.get(kind, identifier) or {}
            identity = (self.gateway.public_identity or {}).get("deviceID")
            host = data.get("executorDeviceId") or identity
            config = {k: data[k] for k in SCHEDULE_CONFIG if k in data}
            value = {**data, **original, **config, "id": identifier, "executorDeviceId": host}


            if host == identity:
                from .schedules import next_run
                timing = {"enabled", "repeat", "time", "timezone", "startDate", "endDate"}
                changed = not original or any(original.get(k) != value.get(k) for k in timing)
                if changed:
                    value["nextRunAt"] = next_run(value)
                if not original:
                    value.update(activeRunId=None, lastResultHash=None, conversationId=data.get("conversationId"))
                if value.get("enabled") and not value.get("nextRunAt") and not value.get("activeRunId"):
                    value.update(enabled=False, status="completed")
                value["status"] = "enabled" if value.get("enabled") else "completed" if value.get("status") == "completed" else "paused"
                if changed:
                    value["updatedAt"] = now()
            else:
                value = {**data, "id": identifier, "executorDeviceId": host}
            self.storage.put(kind, value)
            return True
        if kind == "projects":
            if deleted:
                self.storage.remove(kind, identifier)
            else:
                original = self.storage.get(kind, identifier) or {"path": ""}
                self.storage.put(kind, {**original, **{k: data[k] for k in {"id", "name", "createdAt", "isPinned"} if k in data}, "id": identifier})
            return True
        if kind == "conversations":
            if deleted:
                self.storage.remove(kind, identifier)
                task = self.runtime.tasks.get("conversation:" + identifier)
                if task:
                    task.cancel()
            else:
                original = self.storage.get(kind, identifier) or {"id": identifier, "messages": [], "draft": "", "draftAssets": [], "activeImageId": None, "pendingJobId": None, "pendingMessageId": None, "lastEventId": 0, "hasUnread": True, "lastOpenedAt": None, "titleWasGenerated": False, "reasoning": self.runtime.capabilities.get("defaultReasoning", "low"), "remoteConversationId": identifier, "title": "新聊天", "createdAt": now(), "updatedAt": now(), "titleIsManual": False, "isPinned": False}
                self.storage.put(kind, {**original, **{k: data[k] for k in CONVERSATION_KEYS if k in data}, "id": identifier})
            return True
        conversation_id = data.get("conversationId")
        if deleted:
            previous = self._entity(kind, identifier)
            conversation_id = conversation_id or (previous or {}).get("snapshot", {}).get("conversationId") if (previous or {}).get("snapshot") else conversation_id
        if not conversation_id:
            return False
        parent = self._entity("conversations", conversation_id)
        if parent and parent["deleted"]:
            return False
        if conversations is not None:
            if conversation_id not in conversations:
                conversations[conversation_id] = self.storage.get("conversations", conversation_id)
            conversation = conversations[conversation_id]
        else:
            conversation = self.storage.get("conversations", conversation_id)
        if not conversation:
            return False
        messages = conversation.setdefault("messages", [])
        index = next((i for i, m in enumerate(messages) if m["id"] == identifier), None)
        unread_update = False
        if deleted:
            if index is not None:
                messages.pop(index)
        else:
            original = messages[index] if index is not None else {}
            message = {"id": identifier, "role": "assistant", "text": "", "assets": [], "createdAt": now(), "state": "completed", "phase": "", "error": None, **original, **data}
            for key in ("executionDetailsChanged", "detailsDeferred", "detailsToken"):
                message.pop(key, None)
            if data.get("executionDetailsAvailable") is True:
                merge_compact_details(message, original, data)
                message["detailsDeferred"] = True
                message["detailsToken"] = "sync:" + str(change["revision"])
            else:
                message.pop("executionDetailsAvailable", None)



            owns_stream = conversation.get("pendingMessageId") == identifier
            if owns_stream and original.get("state") == "running" and data.get("state") == "running":
                local_text, remote_text = original.get("text", ""), data.get("text", "")
                if len(local_text) > len(remote_text) and local_text.startswith(remote_text):
                    message["text"] = local_text
            if owns_stream and message.get("state") in {"completed", "failed", "cancelled", "interrupted"}:
                conversation.update(pendingJobId=None, pendingMessageId=None)
                task = self.runtime.tasks.get("conversation:" + conversation_id)
                if task:
                    task.cancel()


            visible_keys = ("text", "state", "error", "fileChanges")
            visible_changed = any(message.get(k) != original.get(k) for k in visible_keys)
            opened = conversation.get("lastOpenedAt")
            newer_than_read = not opened or message_order({"createdAt": message.get("completedAt") or message.get("createdAt")})[0] > message_order({"createdAt": opened})[0]
            unread_update = message.get("role") == "assistant" and (visible_changed if index is not None else newer_than_read)
            if index is None:
                messages.append(message)
            else:
                messages[index] = message
            messages[:] = ordered_messages(messages)
            if message.get("role") == "assistant":
                for asset in message.get("assets", []):
                    self.runtime.record_agent_image(asset, message.get("remoteJobId"), message.get("completedAt") or message.get("createdAt"))
        if unread_update and self.storage.setting("selectedConversationId") != conversation_id:
            conversation["hasUnread"] = True
        if conversations is None:
            self.storage.put("conversations", conversation)
        return True

    async def apply_changes(self, changes, cursor=None):
        prepared = await self._prepare_changes(changes)
        changed = False
        touched = set()
        schedule_ids = set()
        conversations = {}
        def flush_conversations():
            for conversation in conversations.values():
                if conversation:
                    self.storage.put("conversations", conversation)
            conversations.clear()
        with self.storage.lock, self.storage.db:
            self.importing = True
            try:
                for change in prepared:
                    kind, identifier = change["kind"], change["id"]
                    entity = self._entity(kind, identifier)
                    authoritative_output = kind == "messages" and (change.get("data") or {}).get("role") == "assistant" and (change.get("data") or {}).get("remoteJobId")
                    if entity and (int(change["revision"]) < entity["revision"] or (not authoritative_output and int(change["revision"]) == entity["revision"] and entity["snapshot"] == change.get("data") and entity["deleted"] == bool(change.get("deleted")))):
                        continue
                    pending = self.storage.db.execute("SELECT 1 FROM sync_outbox WHERE kind=? AND id=?", (kind, identifier)).fetchone()
                    if pending and not change.get("deleted") and not authoritative_output:
                        continue   
                    # Preserve ordering around metadata/deletions, while writing
                    # each changed conversation only once for a message batch.
                    if kind != "messages":
                        flush_conversations()
                    changed = self._import_document(change, conversations=conversations if kind == "messages" else None) or changed
                    data = change.get("data")
                    if kind == "scheduledTasks" and not change.get("deleted"):
                        schedule_ids.add(identifier)
                    self.storage.db.execute("INSERT INTO sync_entities(kind,id,revision,base,snapshot,deleted) VALUES(?,?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET revision=excluded.revision,base=excluded.base,snapshot=excluded.snapshot,deleted=excluded.deleted", (kind, identifier, int(change["revision"]), encoded(data) if data else None, encoded(data) if data else None, int(bool(change.get("deleted")))))
                    if change.get("deleted") or authoritative_output:
                        self.storage.db.execute("DELETE FROM sync_outbox WHERE kind=? AND id=?", (kind, identifier))
                    if kind == "messages" and (data or {}).get("conversationId"):
                        touched.add(data["conversationId"])
                flush_conversations()
                if cursor is not None:
                    self.storage.set_setting("sync.cursor", int(cursor))
            finally:
                self.importing = False
        if changed:
            self.runtime.notify()
        for identifier in schedule_ids:
            value = self.storage.get("scheduledTasks", identifier)
            if value:
                with self.storage.lock, self.storage.db:
                    self.local_changed("scheduledTasks", value, None)
        for identifier in touched:
            self.runtime.pump_queue(identifier)

    async def resolve_conflict(self, mutation, current):
        if current.get("deleted"):
            await self.apply_changes([current])
            return
        kind, identifier = mutation["kind"], mutation["id"]
        if kind == "scheduledTasks" and (current.get("data") or {}).get("executorDeviceId") not in {None, (self.gateway.public_identity or {}).get("deviceID")}:


            with self.storage.lock, self.storage.db:
                self.storage.db.execute("DELETE FROM sync_outbox WHERE kind=? AND id=?", (kind, identifier))
            await self.apply_changes([current])
            return
        with self.storage.lock, self.storage.db:
            entity = self._entity(kind, identifier) or {}
            base, local, remote = entity.get("base") or {}, mutation.get("data") or {}, current.get("data") or {}
            merged = dict(remote)
            if not mutation["deleted"]:
                for key, value in local.items():
                    if kind == "scheduledTasks" and key not in SCHEDULE_CONFIG and remote.get("executorDeviceId") != (self.gateway.public_identity or {}).get("deviceID"):
                        continue
                    if key not in base or value != base[key]:
                        if kind == "messages" and remote.get("role") == "assistant" and remote.get("remoteJobId") and key in {"text", "state", "phase", "error", "completedAt", "rawResult", "displayItems", "usage"}:
                            continue
                        merged[key] = value
                if kind == "messages" and local.get("executionDetailsAvailable") is True:
                    dirty = {key for key in ("rawResult", "fileChanges", "displayItems") if key in (local.get("executionDetailsChanged") or []) and key in local}
                    if dirty:
                        merged["executionDetailsAvailable"] = True
                        merged["executionDetailsChanged"] = sorted(dirty)
                        if not remote.get("remoteJobId"):
                            # Explicit full values remain intentional even when
                            # they equal the old base but the new base is a preview.
                            for key in dirty:
                                merged[key] = local[key]
            self.storage.db.execute("INSERT INTO sync_conflicts(kind,entity_id,local_data,remote_data,created_at) VALUES(?,?,?,?,?)", (kind, identifier, encoded(local), encoded(remote), now()))
            self.storage.db.execute("UPDATE sync_entities SET revision=?,base=? WHERE kind=? AND id=?", (int(current["revision"]), encoded(remote), kind, identifier))
            self.storage.db.execute("UPDATE sync_outbox SET mutation_id=?,base_revision=?,data=? WHERE kind=? AND id=? AND mutation_id=?", (new_id(), int(current["revision"]), None if mutation["deleted"] else encoded(merged), kind, identifier, mutation["mutationId"]))

    def _clear_accepted_details(self, mutation, revision):
        data = mutation.get("data") or {}
        if mutation["kind"] != "messages" or not data.get("executionDetailsChanged"):
            return
        entity = self._entity("messages", mutation["id"])
        if entity and entity["snapshot"]:
            snapshot = dict(entity["snapshot"])
            snapshot.pop("executionDetailsChanged", None)
            self.storage.db.execute("UPDATE sync_entities SET snapshot=? WHERE kind='messages' AND id=?", (encoded(snapshot), mutation["id"]))
        conversation = self.storage.get("conversations", data.get("conversationId"))
        if not conversation:
            return
        message = next((item for item in conversation.get("messages", []) if item.get("id") == mutation["id"]), None)
        if message is not None:
            for key in ("executionDetailsChanged", "detailsDeferred", "detailsToken"):
                message.pop(key, None)
            message["detailsToken"] = "sync:" + str(revision)
            self.storage.db.execute("UPDATE documents SET data=? WHERE kind='conversations' AND id=?", (encoded(conversation), conversation["id"]))

    def _host_session(self):
        return self.runtime.account.get("owner"), self.gateway.account_token

    def _start_schedule_host_update(self):
        # Host discovery uses local Keychain/model helpers; account chat sync
        # authenticates with its bearer token and must not wait for those helpers.
        if self.runtime.closing or not self.runtime.server_access:
            self._schedule_host_session = None
            self.schedule_host_registered = 0
            if self._schedule_host_task and not self._schedule_host_task.done():
                self._schedule_host_task.cancel()
            return
        session = self._host_session()
        if self._schedule_host_session != session:
            self._schedule_host_session = None
            self.schedule_host_registered = 0
        if self._schedule_host_task and not self._schedule_host_task.done():
            if self._schedule_host_task_session != session:
                self._schedule_host_task.cancel()
            return
        if self._schedule_host_task_session != session:
            self._schedule_host_retry_at = 0
        if asyncio.get_running_loop().time() < self._schedule_host_retry_at:
            return
        self._schedule_host_task_session = session
        self._schedule_host_task = self.runtime.spawn(self._update_schedule_host(session))

    async def _update_schedule_host(self, session):
        try:
            await asyncio.wait_for(self._register_schedule_host(), timeout=self.schedule_host_timeout)
            if session == self._host_session() and self.runtime.server_access and not self.runtime.closing:
                self._schedule_host_session = session
                self.schedule_host_registered = asyncio.get_running_loop().time()
                self.schedule_host_error = None
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self.schedule_host_error = str(exc) or type(exc).__name__
        finally:
            self._schedule_host_retry_at = asyncio.get_running_loop().time() + self.schedule_host_interval

    async def _register_schedule_host(self):
        await self.gateway.ensure_enrolled()
        identity = (await self.gateway.identity())["deviceID"]
        for task in self.storage.list("scheduledTasks"):
            if not task.get("executorDeviceId"):
                task["executorDeviceId"] = identity
                self.storage.put("scheduledTasks", task)
        try:
            local = await self.runtime.mac_codex.models()
        except (ValueError, OSError, asyncio.TimeoutError):
            local = []
        timestamp, nonce = int(time.time() * 1000), new_id()
        proof = "\n".join(["shiyan-schedule-host-v1", self.runtime.account["owner"], identity, str(timestamp), nonce]).encode()
        signature = (await self.gateway.helper_json("sign", proof))["signature"]
        await self.gateway.json("POST", "sync/schedules/host", {"deviceId": identity,
            "devicePublicKey": self.gateway.public_identity["publicKey"], "deviceTime": timestamp,
            "deviceNonce": nonce, "deviceSignature": signature, "local": local,
            "cloud": self.runtime.capabilities.get("models") or [], "defaultModel": self.runtime.capabilities.get("model")})

    async def once(self):
        async with self.lock:
            self._start_schedule_host_update()
            for _ in range(8):
                after = int(self.storage.setting("sync.cursor", 0))
                reply = await self.gateway.sync_get(after)
                await self.apply_changes(reply.get("changes", []), reply.get("cursor", after))
                applied = int(self.storage.setting("sync.cursor", 0))
                if not reply.get("hasMore") or applied <= after:
                    break
            # The server authorizes schedule edits only after this login session
            # has proved its local host. Retain those edits while chat catches up.
            mutations = self.pending(limit=10, include_schedules=self.runtime.server_access and self._schedule_host_session == self._host_session())
            if mutations:
                await self.upload_assets(mutations)
                sent = {m["mutationId"]: m for m in mutations}
                reply = await self.gateway.sync_push({"after": int(self.storage.setting("sync.cursor", 0)), "mutations": mutations})
                with self.storage.lock, self.storage.db:
                    for accepted in reply.get("accepted", []):
                        mutation = sent.get(accepted["mutationId"])
                        if not mutation:
                            continue
                        kind, identifier, revision = mutation["kind"], mutation["id"], int(accepted["revision"])
                        baseline = dict(mutation["data"]) if mutation["data"] else None
                        if kind == "messages" and baseline:
                            baseline.pop("executionDetailsChanged", None)
                        self.storage.db.execute("UPDATE sync_entities SET revision=?,base=? WHERE kind=? AND id=?", (revision, encoded(baseline) if baseline else None, kind, identifier))
                        removed = self.storage.db.execute("DELETE FROM sync_outbox WHERE kind=? AND id=? AND mutation_id=?", (kind, identifier, mutation["mutationId"])).rowcount
                        if removed:
                            self._clear_accepted_details(mutation, revision)


                        self.storage.db.execute("UPDATE sync_outbox SET base_revision=? WHERE kind=? AND id=?", (revision, kind, identifier))
                for conflict in reply.get("conflicts", []):
                    mutation = sent.get(conflict["mutationId"])
                    if mutation:
                        await self.resolve_conflict(mutation, conflict["current"])
                await self.apply_changes(reply.get("changes", []), reply.get("cursor"))
            self.last_error = None

    async def run(self):
        failure_count = 0
        while not self.runtime.closing:
            try:
                await self.once()
                failure_count = 0
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.last_error = str(exc)
                failure_count = min(4, failure_count + 1)
            await asyncio.sleep(min(45, 3 * (2 ** failure_count)))
