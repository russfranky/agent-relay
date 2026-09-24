import { errors } from "../errors.js";
import { authorize, clientIp, parseBearer } from "../auth.js";
import { hashKey } from "../keys.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// Live message stream for browsers (and any HTTP client that can read a
// chunked response). Newline-delimited JSON: one message object per line.
// The client passes ?since=<last seen id>; the server first replays anything
// newer, then holds the connection open, flushing new messages as they land.
// The stream ends after config.streamMaxSeconds; the client reconnects with
// its latest cursor. No polling loops needed.
export default async function streamRoutes(app) {
  const { db, config, limiter } = app;

  app.get("/v1/boxes/:box_id/stream", async (req, reply) => {
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

    const rawRes = req.rawRes;
    if (!rawRes) {
      throw errors.internal("streaming needs a live HTTP connection");
    }

    let since = 0;
    if (req.query.since !== undefined && req.query.since !== "") {
      const n = Number(req.query.since);
      if (Number.isFinite(n) && n >= 0) since = n;
    }

    const res = rawRes;
    reply.hijack();
    res.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    });
    // writeHead alone does not flush: without this the client would not see
    // the 200 until the first message chunk is written.
    res.flushHeaders();

    let cursor = since;
    let closed = false;
    const onClose = () => {
      closed = true;
    };
    res.on("close", onClose);

    const sendNew = async () => {
      const rows = await db
        .prepare(
          `SELECT * FROM messages WHERE box_id = ? AND id > ? ORDER BY id ASC LIMIT 200`
        )
        .all(box.id, cursor);
      for (const row of rows) {
        if (closed) break;
        res.write(JSON.stringify(publicMessage(row)) + "\n");
        cursor = row.id;
      }
      return rows.length;
    };

    try {
      await sendNew(); // catch-up: replay anything the client missed
      const started = Date.now();
      const budgetMs = config.streamMaxSeconds * 1000;
      while (!closed && Date.now() - started < budgetMs) {
        await sleep(config.streamPollMs);
        if (closed) break;
        await sendNew();
      }
    } catch (err) {
      req.log.error({ err: err.message, box_id: box.id }, "stream failed");
    } finally {
      res.off("close", onClose);
      if (!closed) {
        try {
          res.end();
        } catch {
          // client already gone
        }
      }
    }
    return reply;
  });
}
