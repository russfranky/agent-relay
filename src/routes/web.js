import { renderBoxPage, escapeHtml } from "../views/boxPage.js";
import { parseBearer, authorize, clientIp } from "../auth.js";
import { errors } from "../errors.js";
import { hashKey } from "../keys.js";
import { ApiError } from "../errors.js";

export { escapeHtml };

const GENERIC = "Unable to open this box.";

function parseFormString(raw) {
  const out = {};
  for (const part of String(raw ?? "").split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const k = eq === -1 ? part : part.slice(0, eq);
    const v = eq === -1 ? "" : part.slice(eq + 1);
    try {
      out[decodeURIComponent(k.replace(/\+/g, " "))] = decodeURIComponent(
        v.replace(/\+/g, " ")
      );
    } catch {
      out[k] = v;
    }
  }
  return out;
}

function originOf(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost:8787";
  return `${proto}://${host}`;
}

async function loadRecent(db, boxId, limit = 50) {
  return (
    await db
      .prepare(`SELECT * FROM messages WHERE box_id = ? ORDER BY id DESC LIMIT ?`)
      .all(boxId, limit)
  ).reverse();
}

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

function rateLimitRead(app, req, reply) {
  const { config, limiter } = app;
  const ip = clientIp(req);
  const raw = parseBearer(req.headers.authorization);
  const key = raw ? hashKey(raw) : `none:${ip}`;
  const perKey = limiter.hit(`r:${key}`, config.rateLimitReadsPerMin, 60 * 1000);
  const perIp = limiter.hit(`ipr:${ip}`, config.rateLimitIpReadFloorPerMin, 60 * 1000);
  if (!perKey.ok || !perIp.ok) {
    const retry = Math.max(perKey.retryAfter || 1, perIp.retryAfter || 1);
    reply.header("Retry-After", String(retry));
    throw errors.rateLimited(retry);
  }
}

export default async function webRoutes(app) {
  const { db, config } = app;

  if (!app.hasContentTypeParser("application/x-www-form-urlencoded")) {
    app.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string" },
      (req, body, done) => {
        try {
          done(null, parseFormString(body));
        } catch (err) {
          done(err);
        }
      }
    );
  }

  app.get("/b/:box_id", async (req, reply) => {
    // Never look up the box here — title/existence must not leak pre-auth.
    reply.type("text/html; charset=utf-8");
    return renderBoxPage({
      boxId: req.params.box_id,
      title: null,
      messages: [],
      unlocked: false,
      error: null,
      nextSince: 0,
      origin: originOf(req),
    });
  });

  app.post("/b/:box_id", async (req, reply) => {
    reply.type("text/html; charset=utf-8");
    const boxId = req.params.box_id;
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const action = body.action || "unlock";
    const origin = originOf(req);

    if (action === "send") {
      const writeKey = String(body.write_key || "");
      const sender = String(body.sender || "");
      const text = String(body.body || "");
      try {
        const res = await app.inject({
          method: "POST",
          url: `/v1/boxes/${encodeURIComponent(boxId)}/messages`,
          headers: {
            authorization: `Bearer ${writeKey}`,
            "content-type": "application/json",
          },
          payload: { sender, body: text },
        });
        if (res.statusCode >= 400) {
          // Still try to render the box if a read key was also supplied.
        }
      } catch {
        // fall through to unlock render
      }
    }

    const readKey = String(body.read_key || "");
    try {
      const box = await authorize(db, config, boxId, `Bearer ${readKey}`, "read");
      const messages = await loadRecent(db, box.id, 50);
      const nextSince = messages.length ? messages[messages.length - 1].id : 0;
      const oldestId = messages.length ? messages[0].id : null;
      return renderBoxPage({
        boxId,
        title: box.title || "",
        messages,
        error: null,
        unlocked: true,
        nextSince,
        oldestId,
        origin,
        readKeyForForm: readKey,
      });
    } catch (err) {
      const expired = err instanceof ApiError && err.code === "gone_expired";
      return renderBoxPage({
        boxId,
        title: "",
        messages: [],
        error: expired ? "This box has expired." : GENERIC,
        expired,
        unlocked: false,
        nextSince: 0,
        origin,
      });
    }
  });

  app.get("/b/:box_id/snapshot", async (req, reply) => {
    rateLimitRead(app, req, reply);
    const box = await authorize(db, config, req.params.box_id, req.headers.authorization, "read");
    const messages = await loadRecent(db, box.id, 50);
    const nextSince = messages.length ? messages[messages.length - 1].id : 0;
    const oldestId = messages.length ? messages[0].id : null;
    return {
      box_id: box.id,
      title: box.title || "",
      messages: messages.map(publicMessage),
      next_since: nextSince,
      oldest_id: oldestId,
    };
  });

  app.get("/b/:box_id/older", async (req, reply) => {
    rateLimitRead(app, req, reply);
    const box = await authorize(db, config, req.params.box_id, req.headers.authorization, "read");
    let before = Number(req.query.before);
    if (!Number.isFinite(before) || before <= 0) before = Number.MAX_SAFE_INTEGER;
    let limit = Number(req.query.limit);
    if (!Number.isFinite(limit) || limit < 1) limit = 50;
    if (limit > 200) limit = 200;
    const rows = (
      await db
        .prepare(
          `SELECT * FROM messages WHERE box_id = ? AND id < ? ORDER BY id DESC LIMIT ?`
        )
        .all(box.id, before, limit)
    ).reverse();
    return {
      messages: rows.map(publicMessage),
      oldest_id: rows.length ? rows[0].id : null,
    };
  });
}
