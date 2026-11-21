import { createHash } from "node:crypto";

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + stableJson(value[key])).join(",") + "}";
}

function requestError(message, statusCode) {
  const error = new Error(message);
  (error as any).statusCode = statusCode;
  return error;
}

// The server namespaces member request IDs before calling this durable store.
// A request ID spans operations within that account, never between accounts.
export function createRuntimeRequestStore(db,{getOwner=()=> 'shiyan-private-owner',defaultOwner='shiyan-private-owner'}={}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_scoped_requests(owner TEXT NOT NULL,request_id TEXT NOT NULL,operation TEXT NOT NULL,payload_hash TEXT NOT NULL,goal_id INTEGER,response_json TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(owner,request_id));
    CREATE TABLE IF NOT EXISTS runtime_requests (
      request_id TEXT PRIMARY KEY,
      operation TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      goal_id INTEGER,
      response_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);

  return {
    run({ requestId, operation, payload }, mutate) {
      if (requestId === undefined) return { ...mutate(), replayed: false };
      if (typeof requestId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestId)) {
        throw requestError("requestId must be 1-128 letters, digits, dots, underscores, colons or hyphens", 400);
      }
      const fingerprint = createHash("sha256").update(stableJson(payload)).digest("hex");
      db.exec("BEGIN IMMEDIATE");
      try {
        const owner=getOwner(),legacy=owner===defaultOwner;
        const prior = legacy?db.prepare("SELECT * FROM runtime_requests WHERE request_id=?").get(requestId):db.prepare('SELECT * FROM runtime_scoped_requests WHERE owner=? AND request_id=?').get(owner,requestId);
        if (prior) {
          if (prior.operation !== operation || prior.payload_hash !== fingerprint) {
            throw requestError("requestId already used with a different operation or payload", 409);
          }
          db.exec("COMMIT");
          return { response: JSON.parse(prior.response_json), goalId: prior.goal_id, replayed: true };
        }
        const result = mutate();
        if(legacy)db.prepare(`
          INSERT INTO runtime_requests(request_id,operation,payload_hash,goal_id,response_json,created_at)
          VALUES(?,?,?,?,?,?)
        `).run(requestId, operation, fingerprint, result.goalId ?? null, JSON.stringify(result.response), Math.floor(Date.now() / 1000));
        else db.prepare('INSERT INTO runtime_scoped_requests(owner,request_id,operation,payload_hash,goal_id,response_json,created_at) VALUES(?,?,?,?,?,?,?)').run(owner,requestId,operation,fingerprint,result.goalId??null,JSON.stringify(result.response),Math.floor(Date.now()/1000));
        db.exec("COMMIT");
        return { ...result, replayed: false };
      } catch (error) {
        // COMMIT can have completed only on the successful return paths above.
        try { db.exec("ROLLBACK"); } catch {}
        throw error;
      }
    }
  };
}
