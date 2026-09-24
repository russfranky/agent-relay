import { errors } from "../errors.js";
import { authorize, clientIp } from "../auth.js";
import { isExpired, nowIso } from "../db.js";
import { hashKey as hashLimiterKey } from "../keys.js";

function publicRequest(row) {
  return {
    id: row.id,
    box_id: row.box_id,
    from_handle: row.from_handle,
    from_name: row.from_name,
    note: row.note,
    status: row.status,
    created_at: row.created_at,
    decided_at: row.decided_at,
  };
}

// The target of a connection request is identified by a publicly shared
// handle, so there is no key to check here. A missing box still answers
// 401 (not 404) to match the rest of the API and avoid probing.
async function liveBox(db, config, boxId) {
  const box = await db.prepare("SELECT * FROM boxes WHERE id = ?").get(boxId);
  if (!box) throw errors.unauthorized();
  if (isExpired(box, config.retentionDays)) throw errors.goneExpired();
  return box;
}

function checkWriteRateLimit(app, req, reply) {
  const { config, limiter } = app;
  const ip = clientIp(req);
  const raw = req.headers.authorization;
  const key = raw ? hashLimiterKey(raw) : "none";
  const perKey = limiter.hit(`w:${key}`, config.rateLimitWritesPerMin, 60 * 1000);
  const perIp = limiter.hit(`ipw:${ip}`, config.rateLimitIpWriteFloorPerMin, 60 * 1000);
  if (!perKey.ok || !perIp.ok) {
    const retry = Math.max(perKey.retryAfter || 1, perIp.retryAfter || 1);
    reply.header("Retry-After", String(retry));
    throw errors.rateLimited(retry);
  }
}

export default async function requestRoutes(app) {
  const { db, config, limiter } = app;

  // Ask to connect: anyone who knows the handle can request. Rate limited
  // per IP and target box so handles cannot be spammed.
  app.post("/v1/boxes/:box_id/requests", async (req, reply) => {
    const boxId = req.params.box_id;
    const ip = clientIp(req);
    const rl = limiter.hit(`connreq:${ip}:${boxId}`, 20, 60 * 60 * 1000);
    if (!rl.ok) {
      reply.header("Retry-After", String(rl.retryAfter || 60));
      throw errors.rateLimited(rl.retryAfter || 60);
    }

    const box = await liveBox(db, config, boxId);

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const fromHandle = String(body.from_handle || "").trim();
    const fromName = body.from_name == null ? null : String(body.from_name).trim();
    const note = body.note == null ? null : String(body.note).trim();

    if (!fromHandle) throw errors.validation("from_handle is required");
    if (fromHandle.length > 64) throw errors.validation("from_handle must be at most 64 characters");
    if (fromName && fromName.length > 120) throw errors.validation("from_name must be at most 120 characters");
    if (note && note.length > 500) throw errors.validation("note must be at most 500 characters");

    const createdAt = nowIso();
    let info;
    try {
      info = await db
        .prepare(
          `INSERT INTO connection_requests (box_id, from_handle, from_name, note, status, created_at, decided_at)
           VALUES (?, ?, ?, ?, 'pending', ?, NULL)`
        )
        .run(box.id, fromHandle, fromName || null, note || null, createdAt);
    } catch (err) {
      throw errors.internal();
    }
    const row = await db
      .prepare("SELECT * FROM connection_requests WHERE id = ?")
      .get(info.lastInsertRowid);
    reply.code(201);
    return publicRequest(row);
  });

  // List requests (read key). Default is pending only.
  app.get("/v1/boxes/:box_id/requests", async (req, reply) => {
    const box = await authorize(db, config, req.params.box_id, req.headers.authorization, "read");
    const status = String(req.query.status || "pending").toLowerCase();
    const allowed = new Set(["pending", "approved", "rejected", "all"]);
    if (!allowed.has(status)) throw errors.validation("status must be pending, approved, rejected, or all");
    const rows =
      status === "all"
        ? await db
            .prepare(`SELECT * FROM connection_requests WHERE box_id = ? ORDER BY id DESC LIMIT 200`)
            .all(box.id)
        : await db
            .prepare(
              `SELECT * FROM connection_requests WHERE box_id = ? AND status = ? ORDER BY id DESC LIMIT 200`
            )
            .all(box.id, status);
    return { box_id: box.id, status, requests: rows.map(publicRequest) };
  });

  async function decide(req, reply, toStatus) {
    checkWriteRateLimit(app, req, reply);
    const box = await authorize(db, config, req.params.box_id, req.headers.authorization, "write");
    const reqId = Number(req.params.req_id);
    if (!Number.isInteger(reqId) || reqId <= 0) throw errors.validation("req_id must be a positive integer");
    const row = await db
      .prepare("SELECT * FROM connection_requests WHERE id = ? AND box_id = ?")
      .get(reqId, box.id);
    if (!row) throw errors.notFound("connection request not found");
    if (row.status !== toStatus) {
      await db
        .prepare("UPDATE connection_requests SET status = ?, decided_at = ? WHERE id = ?")
        .run(toStatus, nowIso(), reqId);
    }
    const updated = await db.prepare("SELECT * FROM connection_requests WHERE id = ?").get(reqId);
    return publicRequest(updated);
  }

  app.post("/v1/boxes/:box_id/requests/:req_id/approve", async (req, reply) => {
    return decide(req, reply, "approved");
  });

  app.post("/v1/boxes/:box_id/requests/:req_id/reject", async (req, reply) => {
    return decide(req, reply, "rejected");
  });
}
