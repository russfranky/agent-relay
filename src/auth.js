import { timingSafeEqual } from "node:crypto";
import { errors } from "./errors.js";
import { hashKey, isGrantKey, isReadKey, isWriteKey } from "./keys.js";
import { isExpired } from "./db.js";

const BEARER = /^Bearer\s+(\S+)$/i;

export function parseBearer(header) {
  if (!header || typeof header !== "string") return null;
  const m = header.match(BEARER);
  return m ? m[1] : null;
}

function safeEqualHex(a, b) {
  const ab = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

async function findGrant(db, boxId, raw) {
  const row = await db
    .prepare(
      `SELECT * FROM grants WHERE box_id = ? AND revoked_at IS NULL ORDER BY id DESC`
    )
    .all(boxId);
  const hashed = hashKey(raw);
  return row.find((g) => g.scope === "chat" && safeEqualHex(g.token_hash, hashed)) || null;
}

/**
 * Auth-first: missing/malformed header, missing box, and wrong key all
 * return the same 401 so existence is not leaked. Expired boxes return
 * 410 only after the credential is verified.
 *
 * Needs:
 *   read  - read key or guest grant
 *   write - write key or guest grant
 *   owner - write key only(delete box, rotate grants)
 */
export async function authorize(db, config, boxId, header, need) {
  const raw = parseBearer(header);
  if (!raw) throw errors.unauthorized();

  const box = await db.prepare("SELECT * FROM boxes WHERE id = ?").get(boxId);
  if (!box) throw errors.unauthorized();

  const hashed = hashKey(raw);
  let ok = false;
  if (need === "read" && isReadKey(raw)) {
    ok = safeEqualHex(hashed, box.read_key_hash);
  } else if (need === "write" && isWriteKey(raw)) {
    ok = safeEqualHex(hashed, box.write_key_hash);
  } else if (need === "owner" && isWriteKey(raw)) {
    ok = safeEqualHex(hashed, box.write_key_hash);
  } else if ((need === "read" || need === "write") && isGrantKey(raw)) {
    ok = (await findGrant(db, boxId, raw)) !== null;
  }
  if (!ok) throw errors.unauthorized();

  if (isExpired(box, config.retentionDays)) {
    try {
      await db.prepare("INSERT OR REPLACE INTO tombstones (id, deleted_at) VALUES (?, ?)").run(
        box.id,
        new Date().toISOString()
      );
      await db.prepare("DELETE FROM boxes WHERE id = ?").run(box.id);
    } catch {
      // sweeper will retry
    }
    throw errors.goneExpired();
  }
  return box;
}

export function clientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.length) return xf.split(",")[0].trim();
  return req.ip || "0.0.0.0";
}
