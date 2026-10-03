import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { openSqliteDb, nowIso } from "./db.js";
import { generateOwnerToken, hashToken, tokenMatches } from "./keys.js";
import { parseSpkiPublicKey } from "./crypto.js";
import { createRateLimiter } from "./ratelimit.js";
import { createPgRateLimiter } from "./ratelimit-pg.js";
import { validAddress } from "./addresses.js";

const VERSION = "2.0.0";
const MAX_JSON_BYTES = 256 * 1024;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(__dirname, "..", "web");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function err(res, status, code, message) {
  sendJson(res, status, { error: { code, message } });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    // Vercel's Node runtime may pre-buffer the body (req.body) instead of
    // leaving a live stream; handle every shape before touching the stream.
    if (req.body !== undefined && req.body !== null) {
      try {
        if (typeof req.body === "string") {
          return resolve(req.body.trim() ? JSON.parse(req.body) : {});
        }
        if (Buffer.isBuffer(req.body)) {
          const s = req.body.toString("utf8");
          return resolve(s.trim() ? JSON.parse(s) : {});
        }
        if (typeof req.body === "object") return resolve(req.body);
      } catch {
        return reject(Object.assign(new Error("invalid JSON"), { status: 400 }));
      }
    }
    // Stream already ended (or never had a body) before listeners attached.
    if (req.readableEnded || req.complete) return resolve({});
    let bytes = 0;
    const chunks = [];
    req.on("data", (c) => {
      bytes += c.length;
      if (bytes > MAX_JSON_BYTES) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error("invalid JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function bearerToken(req) {
  const h = req.headers["authorization"];
  if (!h || typeof h !== "string") return null;
  const m = h.match(/^Bearer (.+)$/);
  return m ? m[1].trim() : null;
}

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd) return fwd.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

function validB64(s, { minBytes = 1, maxBytes = 64 * 1024 } = {}) {
  if (typeof s !== "string" || s.length === 0) return false;
  let buf;
  try {
    buf = Buffer.from(s, "base64");
  } catch {
    return false;
  }
  // Reject strings that don't round-trip cleanly (not canonical base64).
  if (buf.toString("base64") !== s.replace(/\s+/g, "")) return false;
  return buf.length >= minBytes && buf.length <= maxBytes;
}

export function createApp(options = {}) {
  const {
    db = null,
    dbPath = process.env.RELAY_DB || path.resolve(__dirname, "..", "data", "relay.db"),
    sendLimit = 30,
    sendWindowMs = 60_000,
    limiter: limiterOpt = null,
    maxMsgsPerAddress = Number(process.env.RELAY_MAX_MSGS_PER_ADDRESS || 500),
    msgTtlDays = Number(process.env.RELAY_MSG_TTL_DAYS || 30),
  } = options;

  // db: async adapter ({getAddress, insertAddress, ...}). Defaults to SQLite.
  const store = db || openSqliteDb(dbPath);
  // Postgres gets a shared limiter (all serverless instances enforce the same
  // counters); SQLite/local keeps the in-memory one. An explicit limiter
  // option overrides both (tests).
  const limiter =
    limiterOpt || (store.kind === "pg" && store.sql ? createPgRateLimiter(store.sql) : createRateLimiter());

  function requireOwner(req, res, row) {
    const token = bearerToken(req);
    if (!tokenMatches(token, row.owner_token_hash)) {
      err(res, 401, "unauthorized", "owner token required");
      return false;
    }
    return true;
  }

  async function handler(req, res) {
    const url = new URL(req.url, "http://localhost");
    const pathname = url.pathname;
    const method = req.method;

    try {
      // ---- health ----
      if (method === "GET" && pathname === "/healthz") {
        return sendJson(res, 200, { ok: true, version: VERSION });
      }

      // ---- register address ----
      if (method === "POST" && pathname === "/v1/addresses") {
        const body = await readJsonBody(req);
        if (!validAddress(body.address)) {
          return err(res, 400, "invalid_address", "address must match [a-z0-9][a-z0-9-_]{1,31}@relay");
        }
        if (!validB64(body.public_key, { minBytes: 32, maxBytes: 512 })) {
          return err(res, 400, "invalid_public_key", "public_key must be base64 SPKI DER");
        }
        try {
          parseSpkiPublicKey(body.public_key);
        } catch (e) {
          return err(res, 400, "invalid_public_key", e.message);
        }
        if (await store.getAddress(body.address)) {
          return err(res, 409, "address_taken", "address already registered");
        }
        const ownerToken = generateOwnerToken();
        await store.insertAddress(body.address, body.public_key, hashToken(ownerToken), nowIso());
        return sendJson(res, 201, { address: body.address, owner_token: ownerToken });
      }

      // ---- rotate pubkey / delete address ----
      {
        const m = pathname.match(/^\/v1\/addresses\/([^/]+)$/);
        if (m) {
          const address = decodeURIComponent(m[1]);
          const row = await store.getAddress(address);
          if (!row) return err(res, 404, "not_found", "address not found");
          if (method === "PUT") {
            if (!requireOwner(req, res, row)) return;
            const body = await readJsonBody(req);
            if (!validB64(body.public_key, { minBytes: 32, maxBytes: 512 })) {
              return err(res, 400, "invalid_public_key", "public_key must be base64 SPKI DER");
            }
            try {
              parseSpkiPublicKey(body.public_key);
            } catch (e) {
              return err(res, 400, "invalid_public_key", e.message);
            }
            await store.updatePubkey(body.public_key, address);
            return sendJson(res, 200, { address, rotated: true });
          }
          if (method === "DELETE") {
            if (!requireOwner(req, res, row)) return;
            await store.deleteAddress(address);
            return sendJson(res, 200, { address, deleted: true });
          }
        }
      }

      // ---- directory lookup (open) ----
      {
        const m = pathname.match(/^\/v1\/directory\/([^/]+)$/);
        if (m && method === "GET") {
          const address = decodeURIComponent(m[1]);
          const row = await store.getAddress(address);
          if (!row) return err(res, 404, "not_found", "address not found");
          return sendJson(res, 200, {
            address: row.address,
            public_key: row.public_key,
            created_at: row.created_at,
          });
        }
      }

      // ---- send message (open, rate-limited) ----
      {
        const m = pathname.match(/^\/v1\/inbox\/([^/]+)\/messages$/);
        if (m && method === "POST") {
          const address = decodeURIComponent(m[1]);
          const rl = await limiter.hit(`${clientIp(req)}:${address}`, sendLimit, sendWindowMs);
          if (!rl.ok) {
            return sendJson(
              res,
              429,
              { error: { code: "rate_limited", message: "too many sends, slow down" } },
              { "retry-after": String(rl.retryAfter) }
            );
          }
          const row = await store.getAddress(address);
          if (!row) return err(res, 404, "not_found", "address not found");
          const body = await readJsonBody(req);
          if (!validAddress(body.from)) {
            return err(res, 400, "invalid_from", "from must be a valid address");
          }
          if (!validB64(body.ephemeral_pubkey, { minBytes: 32, maxBytes: 512 })) {
            return err(res, 400, "invalid_envelope", "ephemeral_pubkey must be base64 SPKI DER");
          }
          try {
            parseSpkiPublicKey(body.ephemeral_pubkey);
          } catch (e) {
            return err(res, 400, "invalid_envelope", `ephemeral_pubkey: ${e.message}`);
          }
          if (!validB64(body.nonce) || Buffer.from(body.nonce, "base64").length !== 12) {
            return err(res, 400, "invalid_envelope", "nonce must be 12 bytes base64");
          }
          if (!validB64(body.ciphertext, { minBytes: 17, maxBytes: 256 * 1024 })) {
            return err(res, 400, "invalid_envelope", "ciphertext must be base64");
          }
          // NOTE: thread_id travels inside the encrypted envelope only.
          // A top-level thread_id field is not accepted; the server stays blind.
          const info = await store.insertMessage(
            address,
            body.from,
            body.ephemeral_pubkey,
            body.nonce,
            body.ciphertext,
            nowIso()
          );
          // Retention: bound per-address storage. Cap enforced on every send;
          // TTL expiry swept probabilistically (no cron on serverless).
          if (maxMsgsPerAddress > 0) {
            try { await store.pruneMessages(address, maxMsgsPerAddress); }
            catch (e) { console.error("prune error:", e); }
          }
          if (msgTtlDays > 0 && Math.random() < 0.02) {
            const cutoff = new Date(Date.now() - msgTtlDays * 86400_000).toISOString();
            store.sweepMessagesOlderThan(cutoff).catch((e) => console.error("sweep error:", e));
            store.sweepExpiredDrops(nowIso()).catch((e) => console.error("drop sweep error:", e));
          }
          return sendJson(res, 201, { id: Number(info.lastInsertRowid) });
        }
      }

      // ---- single-use drops: create (open, rate-limited) ----
      {
        const m = pathname.match(/^\/v1\/drops$/);
        if (m && method === "POST") {
          const rl = await limiter.hit(`drop:${clientIp(req)}`, sendLimit, sendWindowMs);
          if (!rl.ok) {
            return sendJson(
              res,
              429,
              { error: { code: "rate_limited", message: "too many drops, slow down" } },
              { "retry-after": String(rl.retryAfter) }
            );
          }
          const body = await readJsonBody(req);
          const ct = body.ciphertext;
          if (typeof ct !== "string" || !/^[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/.test(ct)) {
            return err(res, 400, "invalid_drop", "ciphertext must be nonce_b64.ciphertext_b64");
          }
          if (Buffer.byteLength(ct, "utf8") > 64 * 1024) {
            return err(res, 400, "drop_too_large", "drop ciphertext must fit in 64 KB");
          }
          let ttlHours = Number(body.ttl_hours ?? 72);
          if (!Number.isFinite(ttlHours)) ttlHours = 72;
          ttlHours = Math.min(168, Math.max(1, Math.floor(ttlHours)));
          const id = crypto.randomBytes(9).toString("base64url");
          const now = nowIso();
          const expiresAt = new Date(Date.now() + ttlHours * 3600_000).toISOString();
          await store.createDrop(id, ct, now, expiresAt);
          return sendJson(res, 201, { id, expires_at: expiresAt });
        }
      }

      // ---- single-use drops: read-and-burn (no auth; the URL fragment holds the key) ----
      {
        const m = pathname.match(/^\/v1\/drops\/([A-Za-z0-9_-]{1,64})$/);
        if (m && method === "GET") {
          const row = await store.burnDrop(m[1]);
          if (!row) return err(res, 404, "not_found", "drop not found or already burned");
          return sendJson(res, 200, { ciphertext: row.ciphertext });
        }
      }

      // ---- drop reader page ----
      {
        const m = pathname.match(/^\/d\/[A-Za-z0-9_-]{1,64}$/);
        if (m && method === "GET") {
          const file = path.join(WEB_DIR, "drop.html");
          const data = fs.readFileSync(file);
          res.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "content-length": data.length,
            "cache-control": "no-cache",
          });
          return res.end(data);
        }
      }

      // ---- fetch inbox (owner auth) ----
      {
        const m = pathname.match(/^\/v1\/inbox\/([^/]+)\/messages$/);
        if (m && method === "GET") {
          const address = decodeURIComponent(m[1]);
          const row = await store.getAddress(address);
          if (!row) return err(res, 404, "not_found", "address not found");
          if (!requireOwner(req, res, row)) return;
          const since = Number(url.searchParams.get("since") || 0);
          const rows = await store.listMessages(address, Number.isFinite(since) && since > 0 ? since : 0);
          return sendJson(res, 200, {
            address,
            messages: rows.map((r) => ({
              id: r.id,
              from: r.from_addr,
              to: address,
              ephemeral_pubkey: r.ephemeral_pubkey,
              nonce: r.nonce,
              ciphertext: r.ciphertext,
              created_at: r.created_at,
            })),
          });
        }
      }

      // ---- delete message (owner auth) ----
      {
        const m = pathname.match(/^\/v1\/inbox\/([^/]+)\/messages\/(\d+)$/);
        if (m && method === "DELETE") {
          const address = decodeURIComponent(m[1]);
          const id = Number(m[2]);
          const row = await store.getAddress(address);
          if (!row) return err(res, 404, "not_found", "address not found");
          if (!requireOwner(req, res, row)) return;
          const msg = await store.getMessage(id);
          if (!msg || msg.address !== address) {
            return err(res, 404, "not_found", "message not found");
          }
          await store.deleteMessage(id);
          return sendJson(res, 200, { id, deleted: true });
        }
      }

      // ---- static web UI ----
      if (method === "GET") {
        let rel;
        if (pathname === "/") rel = "landing.html";
        else if (pathname === "/app" || pathname === "/app/") rel = "index.html";
        else rel = pathname.slice(1);
        if (rel.includes("..") || rel.includes("\0")) return err(res, 400, "bad_request", "bad path");
        const file = path.join(WEB_DIR, rel);
        if (!file.startsWith(WEB_DIR + path.sep)) return err(res, 400, "bad_request", "bad path");
        if (fs.existsSync(file) && fs.statSync(file).isFile()) {
          const ext = path.extname(file).toLowerCase();
          const data = fs.readFileSync(file);
          res.writeHead(200, {
            "content-type": MIME[ext] || "application/octet-stream",
            "content-length": data.length,
            "cache-control": ext === ".html" ? "no-cache" : "public, max-age=3600",
          });
          return res.end(data);
        }
      }

      return err(res, 404, "not_found", "not found");
    } catch (e) {
      if (e && e.status) return err(res, e.status, "bad_request", e.message);
      console.error("request error:", e);
      return err(res, 500, "internal", "internal error");
    }
  }

  return {
    handler,
    db: store,
    limiter,
    close() {
      store.close();
    },
  };
}

// Run directly: node src/server.js [port]
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.argv[2] || process.env.RELAY_PORT || 8787);
  const app = createApp();
  const server = http.createServer(app.handler);
  server.listen(port, "127.0.0.1", () => {
    console.log(`agent-relay v${VERSION} listening on http://127.0.0.1:${port}`);
  });
  const shutdown = () => {
    server.close(() => app.close());
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
