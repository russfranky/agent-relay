// Postgres adapter (Neon serverless) with the same async interface as the
// SQLite adapter in db.js. Used on Vercel, where the filesystem is ephemeral
// and mailboxes must survive in a real database.
import { neon } from "@neondatabase/serverless";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS addresses (
    address TEXT PRIMARY KEY,
    public_key TEXT NOT NULL,
    owner_token_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    address TEXT NOT NULL REFERENCES addresses(address) ON DELETE CASCADE,
    sender TEXT NOT NULL,
    ephemeral_pubkey TEXT NOT NULL,
    nonce TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_address ON messages(address, id);

  CREATE TABLE IF NOT EXISTS drops (
    id TEXT PRIMARY KEY,
    ciphertext TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rate_limits (
    "key" TEXT PRIMARY KEY,
    window_start BIGINT NOT NULL,
    count INTEGER NOT NULL,
    prev_count INTEGER NOT NULL
  );
`;

export async function openPgDb(connectionString) {
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  const sql = neon(connectionString);
  // The neon http driver runs one statement per call; split the schema.
  // (Plain-string calls must use sql.query, not the tagged-template form.)
  for (const stmt of SCHEMA.split(";")) {
    const s = stmt.trim();
    if (s) await sql.query(s);
  }
  return {
    kind: "pg",
    // Raw query handle, used by the Postgres rate limiter (ratelimit-pg.js).
    sql,
    async getAddress(address) {
      const rows = await sql`SELECT address, public_key, owner_token_hash, created_at FROM addresses WHERE address = ${address}`;
      return rows[0];
    },
    async insertAddress(address, publicKey, tokenHash, createdAt) {
      await sql`INSERT INTO addresses (address, public_key, owner_token_hash, created_at) VALUES (${address}, ${publicKey}, ${tokenHash}, ${createdAt})`;
    },
    async updatePubkey(publicKey, address) {
      await sql`UPDATE addresses SET public_key = ${publicKey} WHERE address = ${address}`;
    },
    async deleteAddress(address) {
      await sql`DELETE FROM addresses WHERE address = ${address}`;
    },
    async insertMessage(address, sender, ephPubkey, nonce, ciphertext, createdAt) {
      const rows = await sql`INSERT INTO messages (address, sender, ephemeral_pubkey, nonce, ciphertext, created_at) VALUES (${address}, ${sender}, ${ephPubkey}, ${nonce}, ${ciphertext}, ${createdAt}) RETURNING id`;
      return { lastInsertRowid: Number(rows[0].id) };
    },
    async listMessages(address, since) {
      return await sql`SELECT id, sender AS from_addr, ephemeral_pubkey, nonce, ciphertext, created_at FROM messages WHERE address = ${address} AND id > ${since} ORDER BY id ASC LIMIT 500`;
    },
    async getMessage(id) {
      const rows = await sql`SELECT id, address FROM messages WHERE id = ${id}`;
      return rows[0];
    },
    async deleteMessage(id) {
      await sql`DELETE FROM messages WHERE id = ${id}`;
    },
    // Single-use drops: burn-after-reading.
    async createDrop(id, ciphertext, createdAt, expiresAt) {
      await sql`INSERT INTO drops (id, ciphertext, created_at, expires_at) VALUES (${id}, ${ciphertext}, ${createdAt}, ${expiresAt})`;
    },
    async burnDrop(id) {
      const rows = await sql`DELETE FROM drops WHERE id = ${id} RETURNING ciphertext`;
      return rows[0] || null;
    },
    async sweepExpiredDrops(nowIsoStr) {
      await sql`DELETE FROM drops WHERE expires_at < ${nowIsoStr}`;
    },
    // Retention: keep only the newest `keepNewest` messages per address.
    async pruneMessages(address, keepNewest) {
      await sql`DELETE FROM messages WHERE address = ${address} AND id NOT IN (SELECT id FROM messages WHERE address = ${address} ORDER BY id DESC LIMIT ${keepNewest})`;
    },
    // Retention: delete messages older than an ISO timestamp (lazy sweep).
    async sweepMessagesOlderThan(cutoffIso) {
      await sql`DELETE FROM messages WHERE created_at < ${cutoffIso}`;
    },
    close() { /* http driver holds no connection */ },
  };
}
