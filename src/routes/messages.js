import { errors } from "../errors.js";
import { authorize, clientIp, parseBearer } from "../auth.js";
import { nowIso } from "../db.js";
import { hashKey } from "../keys.js";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function publicMessage(row) {
  return {
    id: row.id,
    box_id: row.box_id,
    client_msg_id: row.client_msg_id,
    sender: row.sender,
    recipient: row.recipient,
    reply_to: row.reply_to,
    body: row.body,
    created_at: row.created_at,
  };
}

export default async function messageRoutes(app) {
  const { db, config, limiter } = app;

  app.post("/v1/boxes/:box_id/messages", async (req, reply) => {
    const ip = clientIp(req);
    const rawKey = parseBearer(req.headers.authorization);
    const key = rawKey ? hashKey(rawKey) : "none";
    const perKey = limiter.hit(`w:${key}`, config.rateLimitWritesPerMin, 60 * 1000);
    const perIp = limiter.hit(`ipw:${ip}`, config.rateLimitIpWriteFloorPerMin, 60 * 1000);
    if (!perKey.ok || !perIp.ok) {
      const retry = Math.max(perKey.retryAfter || 1, perIp.retryAfter || 1);
      reply.header("Retry-After", String(retry));
      throw errors.rateLimited(retry);
    }

    const box = await authorize(db, config, req.params.box_id, req.headers.authorization, "write");
    const body = req.body || {};

    const sender = typeof body.sender === "string" ? body.sender.trim() : body.sender;
    if (!sender || typeof sender !== "string") {
      throw errors.validation("sender is required");
    }
    if (sender.length < 1 || sender.length > 80) {
      throw errors.validation("sender must be 1–80 characters");
    }

    if (typeof body.body !== "string") {
      throw errors.validation("body is required");
    }
    if (body.body.length > 65536) {
      throw errors.payloadTooLarge("body must be at most 65536 characters");
    }
    const text = body.body.trim();
    if (!text) {
      throw errors.validation("body is required");
    }

    let recipient = null;
    if (body.recipient !== undefined && body.recipient !== null && body.recipient !== "") {
      if (typeof body.recipient !== "string") throw errors.validation("recipient must be a string");
      recipient = body.recipient.trim();
      if (!recipient || recipient.length > 80) {
        throw errors.validation("recipient must be 1–80 characters");
      }
    }

    let clientMsgId = null;
    if (body.client_msg_id !== undefined && body.client_msg_id !== null && body.client_msg_id !== "") {
      if (typeof body.client_msg_id !== "string" || !UUID_V4.test(body.client_msg_id)) {
        throw errors.validation("client_msg_id must be a UUID v4");
      }
      clientMsgId = body.client_msg_id;
    }

    let replyTo = null;
    if (body.reply_to !== undefined && body.reply_to !== null && body.reply_to !== "") {
      const n = Number(body.reply_to);
      if (!Number.isInteger(n) || n < 1) throw errors.validation("reply_to must be a message id");
      replyTo = n;
    }

    const insert = db.transaction(async () => {
      if (clientMsgId) {
        const existing = await db
          .prepare("SELECT * FROM messages WHERE box_id = ? AND client_msg_id = ?")
          .get(box.id, clientMsgId);
        if (existing) return { existing };
      }

      const count = (await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE box_id = ?").get(box.id)).n;
      if (count >= config.maxBoxMessages) throw errors.boxFull();

      if (replyTo !== null) {
        const parent = await db.prepare("SELECT id, box_id FROM messages WHERE id = ?").get(replyTo);
        if (!parent || parent.box_id !== box.id) {
          throw errors.validation("reply_to must reference a message in this box");
        }
      }

      const createdAt = nowIso();
      const info = await db
        .prepare(
          `INSERT INTO messages (box_id, client_msg_id, sender, recipient, reply_to, body, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(box.id, clientMsgId, sender, recipient, replyTo, text, createdAt);
      await db.prepare("UPDATE boxes SET last_activity_at = ? WHERE id = ?").run(createdAt, box.id);
      const row = await db.prepare("SELECT * FROM messages WHERE id = ?").get(info.lastInsertRowid);
      return { row };
    });

    let result;
    try {
      result = await insert();
    } catch (err) {
      if (err && err.code && err.status) throw err;
      const constraint =
        err && (err.code === "SQLITE_CONSTRAINT_UNIQUE" || err.code === "SQLITE_CONSTRAINT");
      if (constraint && clientMsgId) {
        const existing = await db
          .prepare("SELECT * FROM messages WHERE box_id = ? AND client_msg_id = ?")
          .get(box.id, clientMsgId);
        if (existing) return publicMessage(existing);
      }
      req.log.error(
        { err: err.message, box_id: box.id, bytes: text.length },
        "insert message failed"
      );
      throw errors.internal();
    }

    if (result.existing) {
      req.log.info(
        { box_id: box.id, message_id: result.existing.id, bytes: result.existing.body.length },
        "idempotent retry"
      );
      return publicMessage(result.existing);
    }

    req.log.info(
      { box_id: box.id, message_id: result.row.id, bytes: result.row.body.length },
      "message created"
    );
    reply.code(201);
    return publicMessage(result.row);
  });

  app.get("/v1/boxes/:box_id/messages", async (req, reply) => {
    const ip = clientIp(req);
    const rawKey = parseBearer(req.headers.authorization);
    const key = rawKey ? hashKey(rawKey) : "none";
    const perKey = limiter.hit(`r:${key}`, config.rateLimitReadsPerMin, 60 * 1000);
    const perIp = limiter.hit(`ipr:${ip}`, config.rateLimitIpReadFloorPerMin, 60 * 1000);
    if (!perKey.ok || !perIp.ok) {
      const retry = Math.max(perKey.retryAfter || 1, perIp.retryAfter || 1);
      reply.header("Retry-After", String(retry));
      throw errors.rateLimited(retry);
    }

    const box = await authorize(db, config, req.params.box_id, req.headers.authorization, "read");

    const rawSince = req.query.since;
    let since = 0;
    if (rawSince !== undefined && rawSince !== "") {
      const n = Number(rawSince);
      // Spec: unknown, negative, or future cursors are valid and yield an empty page.
      if (!Number.isFinite(n) || n < 0) {
        return { messages: [], next_since: Number.isFinite(n) ? n : 0 };
      }
      since = n;
    }

    let limit = Number(req.query.limit);
    if (!Number.isFinite(limit)) limit = 50;
    if (limit < 1) limit = 1;
    if (limit > 200) limit = 200;

    // Long-poll: ?wait=SECONDS (0-30) holds the request until a message
    // arrives instead of burning polls. This is the efficient way to wait
    // for a reply — do not poll in a tight loop.
    let waitMs = 0;
    if (req.query.wait !== undefined && req.query.wait !== "") {
      const w = Number(req.query.wait);
      if (!Number.isFinite(w) || w < 0) {
        throw errors.validation("wait must be 0–30 seconds");
      }
      waitMs = Math.min(30, w) * 1000;
    }

    const fetchPage = () =>
      db
        .prepare(
          `SELECT * FROM messages WHERE box_id = ? AND id > ? ORDER BY id ASC LIMIT ?`
        )
        .all(box.id, since, limit);

    let rows;
    try {
      rows = await fetchPage();
      // Long-poll loop: re-check roughly once a second until a message
      // lands or the wait budget runs out.
      const deadline = Date.now() + waitMs;
      while (rows.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
        rows = await fetchPage();
      }
    } catch (err) {
      req.log.error({ err: err.message, box_id: box.id }, "read messages failed");
      throw errors.internal();
    }

    const nextSince = rows.length ? rows[rows.length - 1].id : since;
    return {
      messages: rows.map(publicMessage),
      next_since: nextSince,
    };
  });
}
