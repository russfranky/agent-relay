import { errors } from "../errors.js";
import { generateKeyPair, hashKey } from "../keys.js";
import { generateUniqueCodeAsync } from "../codes.js";
import { nowIso, expiresAt } from "../db.js";
import { authorize, clientIp, parseBearer } from "../auth.js";
import { hashKey as hashLimiterKey } from "../keys.js";

export default async function boxRoutes(app) {
  const { db, config, limiter } = app;

  app.post("/v1/boxes", async (req, reply) => {
    const ip = clientIp(req);
    const create = limiter.hit(`create:${ip}`, config.rateLimitCreatePerIpPerDay, 24 * 60 * 60 * 1000);
    const ipFloor = limiter.hit(`ipw:${ip}`, config.rateLimitIpWriteFloorPerMin, 60 * 1000);
    if (!create.ok || !ipFloor.ok) {
      const retry = Math.max(create.retryAfter || 1, ipFloor.retryAfter || 1);
      reply.header("Retry-After", String(retry));
      throw errors.rateLimited(retry);
    }

    const title = req.body?.title;
    if (title !== undefined && title !== null) {
      if (typeof title !== "string") throw errors.validation("title must be a string");
      if (title.length > 120) throw errors.validation("title must be at most 120 characters");
    }

    const { readKey, writeKey } = generateKeyPair();
    const createdAt = nowIso();

    const code = await generateUniqueCodeAsync(async (id) => {
      const live = await db.prepare("SELECT 1 FROM boxes WHERE id = ?").get(id);
      if (live) return true;
      const tomb = await db.prepare("SELECT 1 FROM tombstones WHERE id = ?").get(id);
      return Boolean(tomb);
    });
    if (!code) throw errors.internal("could not allocate box id");

    try {
      await db.prepare(
        `INSERT INTO boxes (id, read_key_hash, write_key_hash, created_at, last_activity_at, retention_days, title)
         VALUES (?, ?, ?, ?, ?, NULL, ?)`
      ).run(code, hashKey(readKey), hashKey(writeKey), createdAt, createdAt, title ?? null);
    } catch (err) {
      req.log.error({ err: err.message, box_id: code }, "insert box failed");
      throw errors.internal();
    }

    req.log.info({ box_id: code }, "box created");
    reply.code(201);
    return {
      box_id: code,
      read_key: readKey,
      write_key: writeKey,
      created_at: createdAt,
      expires_at: expiresAt(
        { last_activity_at: createdAt, retention_days: null },
        config.retentionDays
      ),
    };
  });

  app.delete("/v1/boxes/:box_id", async (req, reply) => {
    const ip = clientIp(req);
    const rawKey = parseBearer(req.headers.authorization);
    const key = rawKey ? hashLimiterKey(rawKey) : "none";
    const perKey = limiter.hit(`w:${key}`, config.rateLimitWritesPerMin, 60 * 1000);
    const perIp = limiter.hit(`ipw:${ip}`, config.rateLimitIpWriteFloorPerMin, 60 * 1000);
    if (!perKey.ok || !perIp.ok) {
      const retry = Math.max(perKey.retryAfter || 1, perIp.retryAfter || 1);
      reply.header("Retry-After", String(retry));
      throw errors.rateLimited(retry);
    }

    await authorize(db, config, req.params.box_id, req.headers.authorization, "write");

    const tx = db.transaction(async () => {
      await db.prepare("UPDATE messages SET reply_to = NULL WHERE box_id = ?").run(req.params.box_id);
      await db.prepare("DELETE FROM messages WHERE box_id = ?").run(req.params.box_id);
      await db.prepare("INSERT OR REPLACE INTO tombstones (id, deleted_at) VALUES (?, ?)").run(
        req.params.box_id,
        nowIso()
      );
      await db.prepare("DELETE FROM boxes WHERE id = ?").run(req.params.box_id);
    });
    try {
      await tx();
    } catch (err) {
      req.log.error({ err: err.message, box_id: req.params.box_id }, "delete box failed");
      throw errors.internal();
    }
    req.log.info({ box_id: req.params.box_id }, "box deleted");
    return reply.code(204).send();
  });
}
