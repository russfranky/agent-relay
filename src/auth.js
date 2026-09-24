import { errors } from "./errors.js";
import { hashKey, isReadKey, isWriteKey } from "./keys.js";
import { isExpired } from "./db.js";

const BEARER = /^Bearer\s+(\S+)$/i;

export function parseBearer(header) {
  if (!header || typeof header !== "string") return null;
  const m = header.match(BEARER);
  return m ? m[1] : null;
}

/**
 * Auth-first: missing/malformed header, missing box, and wrong key all
 * return the same 401 so existence is not leaked. Expired boxes return
 * 410 only after the matching key is verified.
 */
export async function authorize(db, config, boxId, header, need) {
  const raw = parseBearer(header);
  if (!raw) throw errors.unauthorized();

  if (need === "read" && !isReadKey(raw)) throw errors.unauthorized();
  if (need === "write" && !isWriteKey(raw)) throw errors.unauthorized();

  const box = await db.prepare("SELECT * FROM boxes WHERE id = ?").get(boxId);
  if (!box) throw errors.unauthorized();

  const hashed = hashKey(raw);
  const expected = need === "write" ? box.write_key_hash : box.read_key_hash;
  if (hashed !== expected) throw errors.unauthorized();

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
