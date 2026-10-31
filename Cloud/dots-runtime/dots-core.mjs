import http from "node:http";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const PORT = 4330;
const HOST = "127.0.0.1";
const TOKEN = process.env.DOTS_TOKEN || "";
const CODEX_TOKEN = process.env.OUTSOURCE_TOKEN || "";
const CODEX_URL = "http://127.0.0.1:4320/aiagent/v1/run";
const db = new DatabaseSync("/home/ubuntu/dots-runtime/dots.sqlite");

db.exec(`
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS goals(
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  cadence_minutes INTEGER NOT NULL DEFAULT 0,
  next_run_at TEXT,
  thread_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memories(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id TEXT,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS inbox(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id TEXT,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT
);
CREATE TABLE IF NOT EXISTS runs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  response TEXT,
  error TEXT
);
`);

const busy = new Set();
const now = () => new Date().toISOString();
const goal = id => db.prepare("SELECT * FROM goals WHERE id=?").get(id);

function json(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, {"content-type":"application/json; charset=utf-8","cache-control":"no-store"});
  res.end(text);
}
async function body(req) {
  const chunks=[];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
function memories(id) {
  return db.prepare("SELECT content FROM memories WHERE goal_id=? ORDER BY id DESC LIMIT 30").all(id).reverse().map(x=>x.content);
}
function nextRun(g) {
  return g.cadence_minutes > 0 ? new Date(Date.now()+g.cadence_minutes*60000).toISOString() : null;
}
async function wake(id, trigger="manual") {
  if (busy.has(id)) return {ok:false,error:"already running"};
  const g=goal(id);
  if (!g || g.status !== "active") return {ok:false,error:"goal unavailable"};
  busy.add(id);
  const started=now();
  const run=db.prepare("INSERT INTO runs(goal_id,status,started_at) VALUES(?,?,?)").run(id,"running",started);
  try {
    const prompt = [
      "You are Dots, an always-on personal agent.",
      "The user should not need to decide the next step for you.",
      "Choose the best next action for this goal, reason about it, and produce a concrete progress update.",
      "Do not claim actions you did not actually perform.",
      "",
      "GOAL: "+g.title,
      "OBJECTIVE: "+g.objective,
      "TRIGGER: "+trigger,
      "",
      "MEMORY:",
      ...memories(id).map(x=>"- "+x),
      "",
      "Return: DID, LEARNED, BLOCKED, NEXT."
    ].join("\n");
    const r=await fetch(CODEX_URL,{
      method:"POST",
      headers:{"authorization":"Bearer "+CODEX_TOKEN,"content-type":"application/json"},
      body:JSON.stringify({prompt,threadKey:"dots:"+id,threadId:g.thread_id||undefined,reasoningEffort:"medium"})
    });
    const data=await r.json();
    if(!r.ok || !data.ok) throw new Error(data.error || "codex failed");
    const answer=String(data.finalResponse||"");
    const finished=now();
    db.prepare("UPDATE goals SET thread_id=?,next_run_at=?,updated_at=? WHERE id=?").run(data.threadId||g.thread_id,nextRun(g),finished,id);
    db.prepare("INSERT INTO memories(goal_id,content,created_at) VALUES(?,?,?)").run(id,answer,finished);
    db.prepare("INSERT INTO inbox(goal_id,message,created_at) VALUES(?,?,?)").run(id,answer,finished);
    db.prepare("UPDATE runs SET status='done',finished_at=?,response=? WHERE id=?").run(finished,answer,run.lastInsertRowid);
    return {ok:true,goalId:id,response:answer,nextRunAt:nextRun(goal(id))};
  } catch(e) {
    const finished=now();
    db.prepare("UPDATE runs SET status='error',finished_at=?,error=? WHERE id=?").run(finished,String(e?.message||e),run.lastInsertRowid);
    db.prepare("INSERT INTO inbox(goal_id,message,created_at) VALUES(?,?,?)").run(id,"Run failed: "+String(e?.message||e),finished);
    return {ok:false,error:String(e?.message||e)};
  } finally {
    busy.delete(id);
  }
}

setInterval(()=>{
  const due=db.prepare("SELECT id FROM goals WHERE status='active' AND next_run_at IS NOT NULL AND next_run_at<=? LIMIT 3").all(now());
  for(const x of due) wake(x.id,"scheduled").catch(()=>{});
},30000).unref();

http.createServer(async(req,res)=>{
  try {
    if(TOKEN && req.headers.authorization !== "Bearer "+TOKEN) return json(res,401,{ok:false,error:"unauthorized"});
    const u=new URL(req.url||"/","http://localhost");
    if(req.method==="GET" && u.pathname==="/health") return json(res,200,{ok:true,service:"dots-core",busy:[...busy]});
    if(req.method==="GET" && u.pathname==="/goals") return json(res,200,{ok:true,goals:db.prepare("SELECT * FROM goals ORDER BY created_at DESC").all()});
    if(req.method==="GET" && u.pathname==="/inbox") return json(res,200,{ok:true,inbox:db.prepare("SELECT * FROM inbox ORDER BY id DESC LIMIT 100").all()});
    if(req.method==="POST" && u.pathname==="/goals"){
      const b=await body(req), id=String(b.id||randomUUID()), t=String(b.title||"").trim(), o=String(b.objective||"").trim();
      if(!t||!o) return json(res,400,{ok:false,error:"title and objective required"});
      const c=Math.max(0,Number(b.cadenceMinutes||0)|0), ts=now(), nr=b.runNow===false?(c?new Date(Date.now()+c*60000).toISOString():null):ts;
      db.prepare("INSERT INTO goals(id,title,objective,cadence_minutes,next_run_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(id,t,o,c,nr,ts,ts);
      json(res,201,{ok:true,goal:goal(id)});
      if(b.runNow!==false) wake(id,"created").catch(()=>{});
      return;
    }
    const m=u.pathname.match(/^\/goals\/([^/]+)\/(run|message|pause|resume)$/);
    if(m && req.method==="POST"){
      const id=decodeURIComponent(m[1]), op=m[2], g=goal(id);
      if(!g) return json(res,404,{ok:false,error:"goal not found"});
      if(op==="run") return json(res,200,await wake(id,"manual"));
      if(op==="message"){
        const b=await body(req), msg=String(b.message||b.content||"").trim();
        if(!msg) return json(res,400,{ok:false,error:"message required"});
        db.prepare("INSERT INTO memories(goal_id,content,created_at) VALUES(?,?,?)").run(id,"USER: "+msg,now());
        return json(res,200,await wake(id,"user message: "+msg));
      }
      if(op==="pause"){ db.prepare("UPDATE goals SET status='paused',updated_at=? WHERE id=?").run(now(),id); return json(res,200,{ok:true}); }
      if(op==="resume"){ const ts=now(); db.prepare("UPDATE goals SET status='active',next_run_at=?,updated_at=? WHERE id=?").run(ts,ts,id); return json(res,200,{ok:true}); }
    }
    return json(res,404,{ok:false,error:"not found"});
  } catch(e) {
    return json(res,500,{ok:false,error:String(e?.message||e)});
  }
}).listen(PORT,HOST,()=>console.log("dots-core listening on 127.0.0.1:"+PORT));
