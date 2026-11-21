import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import { toolList, validateToolArguments, PROTOCOL_VERSIONS, protocolVersion, capabilities, CLIENT_CONTEXT_SCHEMA } from "./mcp-contract.ts";

const relationshipTools=new Set(['dots_get_relationship','dots_update_relationship_topic','dots_delete_relationship_topic']);
const relationshipErrors=new Map([
  ['共同话题包含不支持的字段',400],['请填写有效的共同话题',400],['共同话题不存在',404],
  ['共同话题已更新，请刷新后重试',409]
]);

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + stableJson(value[k])).join(",") + "}";
}

function rpc(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message, data: any = undefined) {
  const error: any = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id: id ?? null, error };
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  res.end(body);
}

async function readJson(req, maxBytes = 1024 * 1024) {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new Error("payload too large");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function decodeSecret(secret) {
  if (typeof secret !== "string" || !secret.startsWith("whsec_")) throw new Error("invalid signing secret");
  let raw;
  try { raw = Buffer.from(secret.slice(6), "base64"); } catch { throw new Error("invalid signing secret"); }
  if (raw.length < 24 || raw.length > 64) throw new Error("invalid signing secret length");
  return raw;
}

function sign(secret, id, timestampSec, body) {
  const key = decodeSecret(secret);
  const data = `${id}.${timestampSec}.${body}`;
  return "v1," + createHmac("sha256", key).update(data).digest("base64");
}

function isPrivateIp(ip) {
  ip=ip.toLowerCase();
  if(ip==='::'||ip==='0:0:0:0:0:0:0:0'||ip.startsWith('ff'))return true;
  const mapped=ip.match(/^(?:::ffff:|0:0:0:0:0:ffff:)(.+)$/);
  if(mapped){
    if(isIP(mapped[1])===4)return isPrivateIp(mapped[1]);
    const words=mapped[1].split(':');
    if(words.length===2){const n=parseInt(words[0],16)*65536+parseInt(words[1],16);return isPrivateIp([n>>>24,(n>>>16)&255,(n>>>8)&255,n&255].join('.'));}
    return true;
  }
  if (ip === "::1" || ip === "0:0:0:0:0:0:0:1") return true;
  if (ip.startsWith("fe80:") || ip.startsWith("fc") || ip.startsWith("fd")) return true;
  if (isIP(ip) !== 4) return false;
  const p = ip.split(".").map(Number);
  return p[0] === 10 || p[0] === 127 || p[0] === 0 ||
    (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
    (p[0] >= 224);
}

async function validatePublicHttps(urlString) {
  let url;
  try { url = new URL(urlString); } catch { throw new Error("invalid callback URL"); }
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("callback must be public HTTPS");
  const records = await dns.lookup(url.hostname, { all: true, verbatim: true });
  if (!records.length || records.some((r) => isPrivateIp(r.address))) throw new Error("callback resolves to a private or invalid address");
  return url;
}

async function signedPost(subscription, bodyObject, messageId) {
  await validatePublicHttps(subscription.callback_url);
  const body = JSON.stringify(bodyObject);
  if (Buffer.byteLength(body) > 256 * 1024) throw new Error("event payload exceeds 256 KiB");
  const ts = Math.floor(Date.now() / 1000);
  const response = await fetch(subscription.callback_url, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(10000),
    headers: {
      "content-type": "application/json",
      "webhook-id": messageId,
      "webhook-timestamp": String(ts),
      "webhook-signature": sign(subscription.secret, messageId, ts, body),
      "X-MCP-Subscription-Id": subscription.id
    },
    body
  });
  return response;
}

async function verifyCallback(subscription) {
  const challenge = randomBytes(24).toString("base64url");
  const id = "msg_verify_" + randomUUID();
  const response = await signedPost(subscription, { type: "verification", challenge }, id);
  if (!response.ok) throw new Error("callback verification returned HTTP " + response.status);
  const parsed: any = await response.json().catch(() => ({}));
  const got = Buffer.from(String(parsed.challenge || ""));
  const expected = Buffer.from(challenge);
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) throw new Error("callback challenge mismatch");
}

function eventDefinition() {
  return {
    name: "goal.notification",
    description: "An important Dots goal update occurred, such as completion, failure, blocker, or approval request.",
    delivery: ["webhook"],
    inputSchema: {
      type: "object",
      properties: {
        goal_id: { type: "integer", minimum: 1, description: "Optional goal ID to monitor. Omit to receive important notifications for all goals." }
      },
      additionalProperties: false
    },
    payloadSchema: {
      type: "object",
      properties: {
        goal_id: { type: "integer" },
        notification_id: { type: "integer" },
        output_id: { type: ["integer", "null"] },
        level: { type: "string" },
        title: { type: "string" },
        message: { type: "string" },
        client_context: CLIENT_CONTEXT_SCHEMA
      },
      required: ["goal_id", "notification_id", "output_id", "level", "title", "message"],
      additionalProperties: false
    }
  };
}

export function createMcpBridge({ db, pathSecret, runtimeToken, runtimeBase = "http://127.0.0.1:4330", deliver = signedPost, verify = verifyCallback, retryIntervalMs = 5000,defaultOwner='shiyan-private-owner',getOwner=null,subscriptions=null,registrationNotice=null,settings=null,feedback=null,weixin=null,grants=null,audit:auditView=null,lifeGoals=null }: {db: DatabaseSync; pathSecret?: string; runtimeToken?: string; runtimeBase?: string; deliver?: typeof signedPost; verify?: typeof verifyCallback; retryIntervalMs?: number; defaultOwner?: string; getOwner?: (() => string) | null; subscriptions?: (() => any) | null; registrationNotice?: ((params: any) => any) | null; settings?: (() => any) | null; feedback?: (() => any) | null; weixin?: (() => any) | null; grants?: (() => any) | null; audit?: (() => any) | null; lifeGoals?: (() => any) | null}) {
  const currentOwner=()=>getOwner?.()||defaultOwner;
  const scoped=getOwner!==null;
  db.exec(`CREATE TABLE IF NOT EXISTS dots_weixin_web_message_sync(owner TEXT NOT NULL,request_id TEXT NOT NULL,state TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(owner,request_id))`);
  async function mirrorWebMessage(owner,requestId,content){
    const text=String(content||'').trim();if(!text)return;
    const now=Date.now(),prior=db.prepare('SELECT state,updated_at FROM dots_weixin_web_message_sync WHERE owner=? AND request_id=?').get(owner,requestId);
    if(prior?.state==='sent'||(prior?.state==='sending'&&now-Number(prior.updated_at)<120000))return;
    db.prepare(`INSERT INTO dots_weixin_web_message_sync(owner,request_id,state,updated_at) VALUES(?,?,'sending',?) ON CONFLICT(owner,request_id) DO UPDATE SET state='sending',updated_at=excluded.updated_at`).run(owner,requestId,now);
    try{const bridge=weixin?.();const sent=await bridge?.send?.(text);if(sent)db.prepare(`UPDATE dots_weixin_web_message_sync SET state='sent',updated_at=? WHERE owner=? AND request_id=?`).run(Date.now(),owner,requestId);else db.prepare('DELETE FROM dots_weixin_web_message_sync WHERE owner=? AND request_id=?').run(owner,requestId);}
    catch(error){db.prepare('DELETE FROM dots_weixin_web_message_sync WHERE owner=? AND request_id=?').run(owner,requestId);console.warn('[weixin] web message mirror failed:',(error as any)?.message||error);}
  }
  const ownGoal=id=>!scoped||Boolean(db.prepare('SELECT id FROM goals WHERE id=? AND manager_id=?').get(Number(id),'manager:'+currentOwner()));
  const cursorRow=id=>currentOwner()===defaultOwner?db.prepare('SELECT last_notification_id FROM mcp_notification_cursors WHERE consumer_id=?').get(id):db.prepare('SELECT last_notification_id FROM mcp_scoped_notification_cursors WHERE owner=? AND consumer_id=?').get(currentOwner(),id);
  const subscriptionIdentity=()=>currentOwner()===defaultOwner?effectivePathSecret:effectivePathSecret+':'+currentOwner();
  const effectivePathSecret = pathSecret || createHash("sha256")
    .update("dots-mcp-path:" + runtimeToken)
    .digest("hex")
    .slice(0, 48);

  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_subscriptions (
      id TEXT PRIMARY KEY,
      event_name TEXT NOT NULL,
      arguments_json TEXT NOT NULL,
      callback_url TEXT NOT NULL,
      secret TEXT NOT NULL,
      expires_at INTEGER,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_delivered_at INTEGER,
      last_status INTEGER,
      last_error TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_sub_active ON mcp_subscriptions(active, expires_at);
    CREATE TABLE IF NOT EXISTS mcp_event_request_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL,
      method TEXT NOT NULL,
      outcome TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT ''
    );
  `);

  if(!db.prepare('PRAGMA table_info(mcp_subscriptions)').all().some(c=>c.name==='owner_id'))db.exec("ALTER TABLE mcp_subscriptions ADD COLUMN owner_id TEXT NOT NULL DEFAULT '"+defaultOwner.replaceAll("'","''")+"'");
  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_goal_context (
      goal_id INTEGER PRIMARY KEY, host TEXT NOT NULL, conversation_id TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_context_conversation ON mcp_goal_context(host,conversation_id);
    CREATE TABLE IF NOT EXISTS mcp_scoped_notification_cursors(owner TEXT NOT NULL,consumer_id TEXT NOT NULL,last_notification_id INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(owner,consumer_id));
    CREATE TABLE IF NOT EXISTS mcp_notification_cursors (
      consumer_id TEXT PRIMARY KEY, last_notification_id INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mcp_delivery_outbox (
      subscription_id TEXT NOT NULL, notification_id INTEGER NOT NULL, payload_json TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      next_retry_at INTEGER NOT NULL, last_status INTEGER, last_error TEXT NOT NULL DEFAULT '', delivered_at INTEGER,
      PRIMARY KEY(subscription_id,notification_id)
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_outbox_pending ON mcp_delivery_outbox(state,next_retry_at);
  `);
  const endpointPath = "/mcp/" + effectivePathSecret;

  function matches(pathname) {
    return pathname === endpointPath;
  }

  async function runtime(path, options: any = {}, allowRelationshipError = false, timeoutMs = 15000) {
    const response = await fetch(runtimeBase + path, {
      ...options,
      headers: {
        "authorization": "Bearer " + runtimeToken,
        "content-type": "application/json",
        ...(options.headers || {}),
        "x-dots-owner":currentOwner()
      },
      signal: AbortSignal.timeout(timeoutMs)
    });
    const data: any = await response.json().catch(() => ({}));
    if (!response.ok) {
      if(allowRelationshipError&&relationshipErrors.get(data.error)===response.status) {
        throw Object.assign(new Error(data.error),{relationshipError:{status:response.status,reason:data.error}});
      }
      throw new Error(data.error || ("runtime HTTP " + response.status));
    }
    return data;
  }

  function goalContext(goalId) {
    const row=db.prepare("SELECT host,conversation_id FROM mcp_goal_context WHERE goal_id=?").get(goalId);
    return row ? {host:row.host,conversation_id:row.conversation_id} : null;
  }
  function withContext(data) {
    if(data.goal) return {...data,goal:{...data.goal,client_context:goalContext(data.goal.id)}};
    return data;
  }
  function listNotifications(args) {
    const acknowledged=args.consumer_id ? Number(cursorRow(args.consumer_id)?.last_notification_id||0) : 0;
    const after=args.after_id ?? acknowledged, count=args.limit||50;
    const where=['n.id>?'], values=[after];
    if(scoped){where.push('n.goal_id IN (SELECT id FROM goals WHERE manager_id=?)');values.push('manager:'+currentOwner());}
    if(args.goal_id){where.push('n.goal_id=?');values.push(args.goal_id);}
    if(args.client_context){where.push('c.host=? AND c.conversation_id=?');values.push(args.client_context.host,args.client_context.conversation_id);}
    const rows=db.prepare(`SELECT n.* FROM notifications n LEFT JOIN mcp_goal_context c ON c.goal_id=n.goal_id WHERE ${where.join(' AND ')} ORDER BY n.id ASC LIMIT ?`).all(...values,count+1);
    const notifications: any[]=rows.slice(0,count).map(n=>({...n,client_context:goalContext(n.goal_id)}));
    return{ok:true,notifications,next_cursor:notifications.at(-1)?.id??after,has_more:rows.length>count,acknowledged_cursor:acknowledged,handoff_only:true};
  }
  async function callTool(name, args) {
    validateToolArguments(name,args);
    if(args.owner_id!==undefined&&args.owner_id!==currentOwner())throw new Error('Manager not found');
    if(args.goal_id!==undefined&&!ownGoal(args.goal_id))throw new Error('Goal not found');
    if (relationshipTools.has(name)) {
      const {owner_id=currentOwner(),topicId,...input}=args;
      const base='/v1/managers/'+encodeURIComponent(owner_id)+'/relationship';
      if(name==='dots_get_relationship')return runtime(base,{},true);
      return runtime(base+'/topics/'+encodeURIComponent(topicId),{method:name==='dots_delete_relationship_topic'?'DELETE':'PATCH',...(name==='dots_update_relationship_topic'?{body:JSON.stringify(input)}:{})},true);
    }
    if (name==='dots_reconcile_action')return runtime('/v1/actions/'+encodeURIComponent(args.action_id)+'/reconcile',{method:'POST',body:JSON.stringify({outcome:args.outcome,note:args.note,requestId:args.request_id})});
    if (['dots_get_manager','dots_get_manager_messages','dots_message_manager','dots_control_manager','dots_get_manager_activity'].includes(name)) {
      const owner=args.owner_id||currentOwner();
      const base='/v1/managers/'+encodeURIComponent(owner);
      if(name==='dots_get_manager')return runtime(base);
      if(name==='dots_get_manager_messages')return runtime(base+'/messages?limit='+(args.limit||50)+(args.before_id?'&beforeId='+args.before_id:''));
      if(name==='dots_get_manager_activity')return runtime(base+'/activity?afterId='+(args.after_id||0)+'&limit='+(args.limit||50));
      if(name==='dots_message_manager'){const result=await runtime(base+'/messages',{method:'POST',body:JSON.stringify({message:args.message,requestId:args.request_id,...(args.host?{host:args.host}:{}),...(args.task_id?{taskId:args.task_id}:{})})});if(args.host==='shiyan_web')void mirrorWebMessage(owner,args.request_id,args.display_message||args.message);return result;}
      return runtime(base+'/control',{method:'POST',body:JSON.stringify({action:args.action,...(args.request_id?{requestId:args.request_id}:{})})});
    }
    if (name === "dots_create_goal") {
      const data = await runtime("/v1/goals", {method:"POST",body:JSON.stringify({title:args.title,instruction:args.instruction,runNow:args.run_now!==false,requestId:args.request_id,clientContext:args.client_context})});
      if(args.client_context&&data.goal?.id)db.prepare("INSERT OR IGNORE INTO mcp_goal_context(goal_id,host,conversation_id) VALUES(?,?,?)").run(data.goal.id,args.client_context.host,args.client_context.conversation_id);
      return {...withContext(data),notification_event:"goal.notification",notification_subscription:"ensure_active",realtime_delivery_confirmed:false};
    }
    if (name === "dots_get_goal") return withContext(await runtime("/v1/goals/"+args.goal_id));
    if (name === "dots_read_output") return runtime("/v1/outputs/"+args.output_id);
    if (name === "dots_instruct_goal"||name === "dots_control_goal") {
      const action=name==='dots_instruct_goal'?'instruct':args.action;
      const current=(await runtime('/v1/goals/'+args.goal_id)).goal;
      if(['cancelled','done'].includes(current?.status)&&action!=='cancel')throw new Error('A terminal goal cannot be restarted; create a new goal.');
      if(['instruct','wake','resume'].includes(action)&&current?.status==='waiting_approval')throw new Error('Review pending approvals before continuing this goal.');
      if(['instruct','wake'].includes(action)&&current?.status==='paused')throw new Error('Resume this paused goal explicitly before continuing it.');
      if(action==='resume'&&!['paused','blocked'].includes(current?.status))throw new Error('Only paused or blocked goals can be resumed. Review pending approvals separately.');
      const data=await runtime('/v1/goals/'+args.goal_id+'/'+action,{method:'POST',body:JSON.stringify(action==='instruct'?{message:args.message,requestId:args.request_id}:{})});
      return {...withContext(data),...(action==='pause'||action==='cancel'?{stop_semantics:'Future steps are stopped; an already running Codex turn or OS command may finish.'}:{})};
    }
    if(name==='dots_list_goals'){
      const data=await runtime('/v1/goals');
      const filtered=(data.goals||[]).filter(g=>(!args.status||g.status===args.status)&&(!args.client_context||(goalContext(g.id)?.host===args.client_context.host&&goalContext(g.id)?.conversation_id===args.client_context.conversation_id)));
      return{ok:true,goals:filtered.slice(0,args.limit||50).map(g=>({...g,client_context:goalContext(g.id)})),source_limit:200,source_truncated:(data.goals||[]).length===200,has_more:filtered.length>(args.limit||50)};
    }
    if(name==='dots_get_timeline'){
      await runtime('/v1/goals/'+args.goal_id);
      const count=args.limit||50,after=args.after_id||0;
      const rows=db.prepare('SELECT * FROM timeline WHERE goal_id=? AND id>? ORDER BY id ASC LIMIT ?').all(args.goal_id,after,count+1);
      const timeline=rows.slice(0,count);
      return{ok:true,timeline,next_cursor:timeline.at(-1)?.id??after,has_more:rows.length>count};
    }
    if(name==='dots_list_outputs')return runtime('/v1/outputs?goalId='+args.goal_id+'&limit='+(args.limit||50));
    if(name==='dots_list_notifications')return listNotifications(args);
    if(name==='dots_ack_notifications'){
      if(!db.prepare('SELECT id FROM notifications WHERE id=?').get(args.notification_id)||scoped&&!db.prepare('SELECT n.id FROM notifications n JOIN goals g ON g.id=n.goal_id WHERE n.id=? AND g.manager_id=?').get(args.notification_id,'manager:'+currentOwner()))throw new Error('Notification does not exist.');
      const now=Math.floor(Date.now()/1000);
      if(currentOwner()===defaultOwner)db.prepare(`INSERT INTO mcp_notification_cursors(consumer_id,last_notification_id,updated_at) VALUES(?,?,?) ON CONFLICT(consumer_id) DO UPDATE SET last_notification_id=MAX(last_notification_id,excluded.last_notification_id),updated_at=excluded.updated_at`).run(args.consumer_id,args.notification_id,now);
      else db.prepare('INSERT INTO mcp_scoped_notification_cursors(owner,consumer_id,last_notification_id,updated_at) VALUES(?,?,?,?) ON CONFLICT(owner,consumer_id) DO UPDATE SET last_notification_id=MAX(last_notification_id,excluded.last_notification_id),updated_at=excluded.updated_at').run(currentOwner(),args.consumer_id,args.notification_id,now);
      return{ok:true,consumer_id:args.consumer_id,acknowledged_cursor:Number(cursorRow(args.consumer_id)?.last_notification_id),handoff_only:true};
    }
    if(name==='dots_list_approvals'){
      const data=await runtime('/v1/approvals?status=pending');
      return{...data,approvals:(data.approvals||[]).filter(a=>!args.goal_id||a.goal_id===args.goal_id)};
    }
    if(name==='dots_decide_approval'){
      const data=await runtime('/v1/approvals?status=pending');const approval=data.approvals?.find(a=>a.id===args.approval_id);
      if(!approval)throw new Error('Approval is no longer pending or does not exist.');
      if(args.decision==='approve'&&args.confirmed_command!==approval.command)throw new Error('confirmed_command must exactly match the command reviewed by the user.');
      return runtime('/v1/approvals/'+args.approval_id+'/decision',{method:'POST',body:JSON.stringify({decision:args.decision})});
    }
    if(name==='dots_notification_status'){
      const now=Math.floor(Date.now()/1000);
      const rows=db.prepare('SELECT id,event_name,arguments_json,active,expires_at,last_delivered_at,last_status FROM mcp_subscriptions WHERE owner_id=? ORDER BY created_at DESC').all(currentOwner());
      const subscriptions=rows.filter(s=>!args.goal_id||JSON.parse(String(s.arguments_json)).goal_id===undefined||JSON.parse(String(s.arguments_json)).goal_id===args.goal_id).map(s=>({id:s.id,event:s.event_name,goal_id:JSON.parse(String(s.arguments_json)).goal_id??null,active:Boolean(s.active)&&(!s.expires_at||Number(s.expires_at)>now),expires_at:s.expires_at,last_webhook_accepted_at:s.last_delivered_at,last_http_status:s.last_status,...db.prepare("SELECT COALESCE(SUM(state='pending'),0) AS pending,COALESCE(SUM(state='failed'),0) AS failed,COALESCE(SUM(state='delivered'),0) AS delivered FROM mcp_delivery_outbox WHERE subscription_id=?").get(s.id)}));
      return{ok:true,subscriptions,conversation_display_confirmed:false};
    }
    if(name==='dots_get_capabilities')return{ok:true,service:'Dots Runtime',bridge_version:'0.6.0',protocol_versions:PROTOCOL_VERSIONS,tool_names:toolList().map(t=>t.name),ownership:'per-user-isolated',auth:'secret URL capability; host auth setting is noauth',conversation_context:true,idempotent_requests:true,notification_cursor:true,timeline_cursor:true,per_consumer_ack:true,durable_webhook_outbox:true,events_require_host_callback:true,manager:true,manager_activity_replay:true,manager_webhook:false,worker_concurrency:2,hard_budgets:false,recurring_schedules:false,shiyan_client_adapter_installed:process.env.DOTS_SHIYAN_ADAPTER_INSTALLED==='1',stop_semantics:'pause/cancel stops future steps; already running operations may finish'};
    throw new Error('Unknown tool');
  }

  async function subscribe(params) {
    if (params?.name !== "goal.notification") throw new Error("unsupported event");
    const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
    if (Object.keys(args).some((k) => k !== "goal_id")) throw new Error("unsupported event arguments");
    if (args.goal_id !== undefined && (!Number.isInteger(args.goal_id) || args.goal_id < 1)) throw new Error("invalid goal_id");
    if(args.goal_id!==undefined&&!ownGoal(args.goal_id))throw new Error('Goal not found');
    if (params?.delivery?.mode !== "webhook") throw new Error("webhook delivery required");
    const callback = String(params.delivery.url || "");
    const secret = String(params.delivery.secret || "");
    decodeSecret(secret);
    await validatePublicHttps(callback);

    const identity = stableJson({ event: params.name, args, callback, owner: subscriptionIdentity() });
    const id = "sub_" + createHash("sha256").update(identity).digest("hex").slice(0, 32);
    const ttl = params.ttlMs === null ? null : Math.min(Math.max(Number(params.ttlMs || 7 * 86400000), 600000), 7 * 86400000);
    const nowSec = Math.floor(Date.now() / 1000);
    const expires = ttl === null ? null : nowSec + Math.floor(ttl / 1000);
    const provisional = { id, callback_url: callback, secret };
    await verify(provisional);

    db.prepare(`
      INSERT INTO mcp_subscriptions(id,event_name,arguments_json,callback_url,secret,expires_at,active,created_at,updated_at,owner_id)
      VALUES(?,?,?,?,?,?,1,?,?,?)
      ON CONFLICT(id) DO UPDATE SET secret=excluded.secret,expires_at=excluded.expires_at,active=1,updated_at=excluded.updated_at
    `).run(id, params.name, stableJson(args), callback, secret, expires, nowSec, nowSec,currentOwner());

    return {
      id,
      refreshBefore: expires === null ? null : new Date(expires * 1000).toISOString(),
      cursor: null,
      truncated: false
    };
  }

  function unsubscribe(params) {
    const args = params?.arguments && typeof params.arguments === "object" ? params.arguments : {};
    const callback = String(params?.delivery?.url || "");
    const identity = stableJson({ event: params?.name, args, callback, owner: subscriptionIdentity() });
    const id = "sub_" + createHash("sha256").update(identity).digest("hex").slice(0, 32);
    db.prepare("UPDATE mcp_subscriptions SET active=0,updated_at=? WHERE id=? AND owner_id=?")
      .run(Math.floor(Date.now() / 1000), id,currentOwner());
    return {};
  }

  async function handle(req, res) {
    if (req.method !== "POST") {res.setHeader('Allow','POST');return sendJson(res,405,{error:'POST required'});}
    let msg;
    try { msg = await readJson(req); } catch (e) { return sendJson(res, 400, rpcError(null, -32700, "Parse error")); }
    if(!msg||typeof msg!=='object'||Array.isArray(msg)||msg.jsonrpc!=='2.0'||typeof msg.method!=='string'||msg.id!==undefined&&msg.id!==null&&!['string','number'].includes(typeof msg.id)||msg.params!==undefined&&(!msg.params||typeof msg.params!=='object'||Array.isArray(msg.params)))return sendJson(res,400,rpcError(null,-32600,'Invalid Request'));
    const id = msg.id ?? null;
    const method = msg.method;
    if(msg.id===undefined){res.writeHead(202);return res.end();}
    const audited = ["server/discover", "events/list", "events/subscribe", "events/unsubscribe"].includes(method);
    const audit = (outcome, reason = "") => {
      if (audited) db.prepare("INSERT INTO mcp_event_request_audit(created_at,method,outcome,reason) VALUES(?,?,?,?)")
        .run(Math.floor(Date.now() / 1000), method, outcome, reason);
    };
    audit("received");

    try {
      if(method==='dots/internal/registration'&&registrationNotice&&req.dotsPrivateTransport===true&&currentOwner()===defaultOwner)return sendJson(res,200,rpc(id,await registrationNotice(msg.params)));
      if(method.startsWith('dots/weixin/')&&weixin){
        const w=weixin(),p=msg.params||{};
        const result=method==='dots/weixin/status'?await w.status():method==='dots/weixin/login'?await w.startLogin():method==='dots/weixin/verify'?await w.submitVerifyCode(p.code):method==='dots/weixin/unbind'?await w.unbind():method==='dots/weixin/push'?await w.setPush(p.enabled===true):null;
        if(result)return sendJson(res,200,rpc(id,result));
      }
      if(method.startsWith('dots/people/')){
        const p=msg.params||{},owner=currentOwner(),base='/v1/managers/'+encodeURIComponent(owner)+'/people';
        const person=encodeURIComponent(String(p.person_id||'')),memory=encodeURIComponent(String(p.memory_id||''));
        let path='',options={},timeout=30000;
        if(method==='dots/people/list')path=base;
        else if(method==='dots/people/create'){path=base;options={method:'POST',body:JSON.stringify({name:p.name,relationship:p.relationship||''})};}
        else if(method==='dots/people/get')path=base+'/'+person;
        else if(method==='dots/people/update'){path=base+'/'+person;options={method:'PATCH',body:JSON.stringify({name:p.name,relationship:p.relationship,summary:p.summary,active:typeof p.active==='boolean'?p.active:undefined,relearn:p.relearn===true?true:undefined})};if(p.relearn===true)timeout=180000;}
        else if(method==='dots/people/delete'){path=base+'/'+person;options={method:'DELETE'};}
        else if(method==='dots/people/import'){path=base+'/'+person+'/import';options={method:'POST',body:JSON.stringify({importId:p.import_id,source:'wechat',format:p.format,messages:p.messages,final:p.final===true})};timeout=180000;}
        else if(method==='dots/people/messages/list')path=base+'/'+person+'/messages?before='+(Number(p.before)||0)+'&limit='+(Number(p.limit)||100);
        else if(method==='dots/people/messages/send'){path=base+'/'+person+'/messages';options={method:'POST',body:JSON.stringify({requestId:p.request_id,message:p.message})};timeout=180000;}
        else if(method==='dots/people/memories/list')path=base+'/'+person+'/memories';
        else if(method==='dots/people/memories/update'){path=base+'/'+person+'/memories/'+memory;options={method:'PATCH',body:JSON.stringify({content:p.content})};}
        else if(method==='dots/people/memories/delete'){path=base+'/'+person+'/memories/'+memory;options={method:'DELETE'};}
        else throw new Error('Unknown digital people operation');
        return sendJson(res,200,rpc(id,await runtime(path,options,false,timeout)));
      }
      if(method==='dots/messages/feedback'&&feedback)return sendJson(res,200,rpc(id,feedback().messageFeedback(msg.params||{})));
      if(method.startsWith('dots/life-goals/')&&lifeGoals){
        const g=lifeGoals(),p=msg.params||{},action=method.slice('dots/life-goals/'.length);
        const result=action==='list'?g.list():action==='create'?g.create(p.goal||{}):action==='update'?g.update(p.id,p.goal||{}):action==='milestone'?g.milestone(p.id,p.change||{}):action==='replan'?g.replan(p.id):action==='remove'?g.remove(p.id):null;
        if(result)return sendJson(res,200,rpc(id,result));
      }
      if(method==='dots/audit/list'&&auditView)return sendJson(res,200,rpc(id,await auditView().list(msg.params||{})));
      if(method==='dots/grants/list'&&grants)return sendJson(res,200,rpc(id,await grants().list()));
      if(method==='dots/grants/create'&&grants)return sendJson(res,200,rpc(id,await grants().create(msg.params)));
      if(method==='dots/grants/revoke'&&grants)return sendJson(res,200,rpc(id,await grants().revoke(msg.params)));
      if(method==='dots/settings/get'&&settings)return sendJson(res,200,rpc(id,{ok:true,settings:await settings().get()}));
      if(method==='dots/settings/update'&&settings)return sendJson(res,200,rpc(id,await settings().update(msg.params)));
      if(method==='dots/subscriptions/list'&&subscriptions)return sendJson(res,200,rpc(id,await subscriptions().list()));
      if(method==='dots/subscriptions/update'&&subscriptions)return sendJson(res,200,rpc(id,await subscriptions().update(msg.params?.provider,msg.params?.config)));
      if(method==='dots/subscriptions/delete'&&subscriptions)return sendJson(res,200,rpc(id,await subscriptions().remove(msg.params?.provider)));
      if (method === "server/discover") {
        return sendJson(res, 200, rpc(id, {
          resultType: "complete",
          supportedVersions: PROTOCOL_VERSIONS,
          capabilities: { tools: {}, events: {} }
        }));
      }
      if (method === "initialize") {
        return sendJson(res, 200, rpc(id, {
          protocolVersion: protocolVersion(msg.params?.protocolVersion),
          capabilities: capabilities(protocolVersion(msg.params?.protocolVersion)),
          serverInfo: { name: "Dots Runtime", version: "0.5.0" },
          instructions: "Use Dots for persistent goals. Creating or continuing a Dots goal is standing authorization to monitor that goal's important lifecycle updates. After creating a goal, automatically ensure a goal.notification subscription is active for that goal; reuse or refresh a suitable existing subscription and do not ask the user to repeat monitoring language. Important results are delivered through goal.notification events; full Codex output can be retrieved by output_id."
        }));
      }
      if (method === "notifications/initialized") {
        res.writeHead(202); return res.end();
      }
      if (method === "tools/list") return sendJson(res, 200, rpc(id, { tools: toolList() }));
      if (method === "ping") return sendJson(res,200,rpc(id,{}));
      if (method === "tools/call") {
        let result;
        try {result=await callTool(String(msg.params?.name||""),msg.params?.arguments??{});}
        catch(e){
          if((e as any).rpcCode)return sendJson(res,200,rpcError(id,(e as any).rpcCode,(e as any).message));
          if(relationshipTools.has(String(msg.params?.name||''))){
            const error=(e as any).relationshipError;
            if(error&&relationshipErrors.get(error.reason)===error.status){
              const code=error.status===409?'relationship_conflict':error.status===404?'relationship_not_found':'relationship_invalid';
              return sendJson(res,200,rpc(id,{isError:true,content:[{type:'text',text:error.reason}],structuredContent:{ok:false,error:{...error,code}}}));
            }
            return sendJson(res,200,rpc(id,{isError:true,content:[{type:'text',text:'Dots 暂时无法更新交流设置，请稍后重试'}]}));
          }
          return sendJson(res,200,rpc(id,{isError:true,content:[{type:'text',text:String((e as any).message||e).slice(0,500)}]}));
        }
        return sendJson(res, 200, rpc(id, {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result
        }));
      }
      if (method === "events/list") {
        audit("succeeded");
        return sendJson(res, 200, rpc(id, { events: [eventDefinition()] }));
      }
      if (method === "events/subscribe") {
        try {
          const result = await subscribe(msg.params || {});
          audit("succeeded", "callback_verified_and_stored");
          return sendJson(res, 200, rpc(id, result));
        }
        catch (e) {
          const reason = /callback|HTTPS|address|challenge|HTTP|timeout/i.test(String((e as any).message)) ? "challenge_failed" : "invalid_request";
          audit("failed", reason);
          return sendJson(res, 200, rpcError(id, -32015, "CallbackEndpointError", { reason, detail: String((e as any).message).slice(0, 300) }));
        }
      }
      if (method === "events/unsubscribe") {
        const result = unsubscribe(msg.params || {});
        audit("succeeded");
        return sendJson(res, 200, rpc(id, result));
      }
      return sendJson(res, 200, rpcError(id, -32601, "Method not found"));
    } catch (e) {
      return sendJson(res, 200, rpcError(id, -32000, String((e as any)?.message || e).slice(0, 500)));
    }
  }

  let pumping=false;
  async function flushDeliveries() {
    if(pumping)return;
    pumping=true;
    try{
      const nowSec=Math.floor(Date.now()/1000);
      const rows=db.prepare(`SELECT o.*,s.callback_url,s.secret,s.active,s.expires_at FROM mcp_delivery_outbox o JOIN mcp_subscriptions s ON s.id=o.subscription_id WHERE o.state='pending' AND o.next_retry_at<=? ORDER BY o.next_retry_at,o.notification_id LIMIT 20`).all(nowSec);
      for(const row of rows){
        if(!row.active||row.expires_at!==null&&Number(row.expires_at)<=nowSec){db.prepare("UPDATE mcp_delivery_outbox SET state='inactive' WHERE subscription_id=? AND notification_id=?").run(row.subscription_id,row.notification_id);continue;}
        const event=JSON.parse(String(row.payload_json)),attempts=Number(row.attempts)+1;
        let status: any=null,error='',accepted=false;
        try{const response=await deliver({...row,id:row.subscription_id},event,event.eventId);status=response.status;accepted=response.ok;if(!accepted)error='HTTP '+status;}
        catch{error='Webhook transport failed';}
        const state=accepted?'delivered':status===410||status===413||attempts>=8?'failed':'pending';
        const next=nowSec+Math.min(300,2**attempts);
        db.prepare(`UPDATE mcp_delivery_outbox SET state=?,attempts=?,next_retry_at=?,last_status=?,last_error=?,delivered_at=? WHERE subscription_id=? AND notification_id=?`).run(state,attempts,next,status,error,accepted?Math.floor(Date.now()/1000):null,row.subscription_id,row.notification_id);
        db.prepare(`UPDATE mcp_subscriptions SET last_delivered_at=CASE WHEN ? THEN ? ELSE last_delivered_at END,last_status=?,last_error=?,updated_at=? WHERE id=?`).run(accepted?1:0,Math.floor(Date.now()/1000),status,error,nowSec,row.subscription_id);
        if(status===410)db.prepare('UPDATE mcp_subscriptions SET active=0 WHERE id=?').run(row.subscription_id);
      }
    }finally{pumping=false;}
  }
  async function emitNotification(notification) {
    const nowSec=Math.floor(Date.now()/1000);
    const notificationOwner=scoped?String(db.prepare("SELECT manager_id FROM goals WHERE id=?").get(Number(notification.goalId))?.manager_id ?? '').slice(8):defaultOwner;
    if(!notificationOwner)return;
    const subs=db.prepare("SELECT id,arguments_json FROM mcp_subscriptions WHERE owner_id=? AND active=1 AND event_name='goal.notification' AND (expires_at IS NULL OR expires_at>?)").all(notificationOwner,nowSec);
    for(const sub of subs){
      const args=JSON.parse(String(sub.arguments_json||'{}'));
      if(args.goal_id!==undefined&&Number(args.goal_id)!==Number(notification.goalId))continue;
      const context=goalContext(notification.goalId);
      const event={eventId:'evt_'+notification.id+'_'+String(sub.id).slice(-10),name:'goal.notification',timestamp:new Date(notification.createdAt*1000).toISOString(),data:{goal_id:Number(notification.goalId||0),notification_id:Number(notification.id),output_id:notification.outputId==null?null:Number(notification.outputId),level:String(notification.level),title:String(notification.title),message:String(notification.body),...(context?{client_context:context}:{})},cursor:String(notification.id)};
      db.prepare(`INSERT OR IGNORE INTO mcp_delivery_outbox(subscription_id,notification_id,payload_json,next_retry_at) VALUES(?,?,?,?)`).run(sub.id,notification.id,JSON.stringify(event),nowSec);
    }
    await flushDeliveries();
  }
  const retryTimer=retryIntervalMs>0?setInterval(()=>{void flushDeliveries().catch(()=>{});},retryIntervalMs):null;
  retryTimer?.unref();
  function close(){if(retryTimer)clearInterval(retryTimer);}
  return { matches, handle, emitNotification, endpointPath, flushDeliveries, close };
}
