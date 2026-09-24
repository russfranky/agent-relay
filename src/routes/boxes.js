import { errors } from "../errors.js";
import { generateGrant, generateKeyPair, hashKey } from "../keys.js";
import { generateUniqueCodeAsync } from "../codes.js";
import { nowIso, expiresAt } from "../db.js";
import { authorize, clientIp, parseBearer } from "../auth.js";
import { hashKey as hashLimiterKey } from "../keys.js";
import { validateHandle } from "../handles.js";

async function handleTaken(db, handle) {
  const live = await db.prepare("SELECT 1 FROM boxes WHERE id = ?").get(handle);
  if (live) return true;
  const tomb = await db.prepare("SELECT 1 FROM tombstones WHERE id = ?").get(handle);
  return Boolean(tomb);
}

// The human share link. The grant rides in the URL fragment so it never
// reaches server logs; the browser sends it as an Authorization header.
export function shareUrlFor(boxId, grant) {
  return `/c/${encodeURIComponent(boxId)}#g=${encodeURIComponent(grant)}`;
}

async function mintGrant(db, boxId, label) {
  const grant = generateGrant();
  const createdAt = nowIso();
  await db
    .prepare(
      `INSERT INTO grants (box_id, label, token_hash, scope, created_at, revoked_at)
       VALUES (?, ?, ?, 'chat', ?, NULL)`
    )
    .run(boxId, label, hashKey(grant), createdAt);
  return grant;
}

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

    // Optional custom handle: a human-readable box id like "russ".
    // The handle becomes the box id itself.
    let code;
    let customHandle = false;
    if (req.body?.handle !== undefined && req.body?.handle !== null && req.body.handle !== "") {
      const checked = validateHandle(req.body.handle);
      if (!checked.ok) throw errors.validation(checked.message);
      if (await handleTaken(db, checked.handle)) {
        throw errors.conflict("that handle is already taken");
      }
      code = checked.handle;
      customHandle = true;
    } else {
      code = await generateUniqueCodeAsync(async (id) => {
        const live = await db.prepare("SELECT 1 FROM boxes WHERE id = ?").get(id);
        if (live) return true;
        const tomb = await db.prepare("SELECT 1 FROM tombstones WHERE id = ?").get(id);
        return Boolean(tomb);
      });
      if (!code) throw errors.internal("could not allocate box id");
    }

    const { readKey, writeKey } = generateKeyPair();
    const createdAt = nowIso();

    try {
      await db.prepare(
        `INSERT INTO boxes (id, read_key_hash, write_key_hash, created_at, last_activity_at, retention_days, title)
         VALUES (?, ?, ?, ?, ?, NULL, ?)`
      ).run(code, hashKey(readKey), hashKey(writeKey), createdAt, createdAt, title ?? null);
    } catch (err) {
      // Race: two creates claimed the same custom handle at once.
      if (customHandle && err && err.code === "SQLITE_CONSTRAINT_UNIQUE") {
        throw errors.conflict("that handle is already taken");
      }
      req.log.error({ err: err.message, box_id: code }, "insert box failed");
      throw errors.internal();
    }

    // Every box gets one human share link at birth. Minting is atomic with
    // the box: a box without a share link is useless to a human, so a mint
    // failure deletes the box and reports 500 instead of a half-made chat.
    let shareUrl;
    try {
      shareUrl = shareUrlFor(code, await mintGrant(db, code, "share link"));
    } catch (err) {
      req.log.error({ err: err.message, box_id: code }, "mint grant failed");
      try {
        await db.prepare("DELETE FROM boxes WHERE id = ?").run(code);
      } catch {
        // best effort cleanup; the sweep will expire the orphan
      }
      throw errors.internal();
    }

    req.log.info({ box_id: code }, "box created");
    reply.code(201);
    return {
      box_id: code,
      handle: customHandle ? code : null,
      read_key: readKey,
      write_key: writeKey,
      // Human share link (relative). The grant is shown once, like the keys.
      share_url: shareUrl,
      created_at: createdAt,
      expires_at: expiresAt(
        { last_activity_at: createdAt, retention_days: null },
        config.retentionDays
      ),
    };
  });

  // New invite link: revoke every active grant and mint a fresh one.
  // Owner only (write key). The old link stops working immediately.
  app.post("/v1/boxes/:box_id/share/rotate", async (req, reply) => {
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

    const box = await authorize(db, config, req.params.box_id, req.headers.authorization, "owner");

    const rotate = db.transaction(async () => {
      await db
        .prepare(`UPDATE grants SET revoked_at = ? WHERE box_id = ? AND revoked_at IS NULL`)
        .run(nowIso(), box.id);
      return await mintGrant(db, box.id, "share link");
    });
    let grant;
    try {
      grant = await rotate();
    } catch (err) {
      req.log.error({ err: err.message, box_id: box.id }, "rotate grant failed");
      throw errors.internal();
    }
    req.log.info({ box_id: box.id }, "share link rotated");
    return {
      box_id: box.id,
      share_url: shareUrlFor(box.id, grant),
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

    await authorize(db, config, req.params.box_id, req.headers.authorization, "owner");

    const tx = db.transaction(async () => {
      await db.prepare("UPDATE messages SET reply_to = NULL WHERE box_id = ?").run(req.params.box_id);
      await db.prepare("DELETE FROM messages WHERE box_id = ?").run(req.params.box_id);
      await db.prepare("DELETE FROM connection_requests WHERE box_id = ?").run(req.params.box_id);
      await db.prepare("DELETE FROM grants WHERE box_id = ?").run(req.params.box_id);
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
