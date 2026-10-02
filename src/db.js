import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// SQLite adapter with async methods (wraps node:sqlite sync calls).
// v2 schema: addresses own a mailbox; messages are opaque E2E envelopes.
// The server never stores plaintext subject/body/thread_id.
export function openSqliteDb(dbPath) {
  if (dbPath !== ":memory:") {
    const dir = path.dirname(dbPath);
    if (dir && dir !== ".") fs.mkdirSync(dir, { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS addresses (
      address TEXT PRIMARY KEY,
      public_key TEXT NOT NULL,
      owner_token_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      address TEXT NOT NULL,
      sender TEXT NOT NULL,
      ephemeral_pubkey TEXT NOT NULL,
      nonce TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (address) REFERENCES addresses(address) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_address ON messages(address, id);
  `);

  const getAddress = db.prepare("SELECT address, public_key, owner_token_hash, created_at FROM addresses WHERE address = ?");
  const insertAddress = db.prepare(
    "INSERT INTO addresses (address, public_key, owner_token_hash, created_at) VALUES (?, ?, ?, ?)"
  );
  const updatePubkey = db.prepare("UPDATE addresses SET public_key = ? WHERE address = ?");
  const deleteAddress = db.prepare("DELETE FROM addresses WHERE address = ?");
  const insertMessage = db.prepare(
    "INSERT INTO messages (address, sender, ephemeral_pubkey, nonce, ciphertext, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const listMessages = db.prepare(
    "SELECT id, sender AS from_addr, ephemeral_pubkey, nonce, ciphertext, created_at FROM messages WHERE address = ? AND id > ? ORDER BY id ASC LIMIT 500"
  );
  const getMessage = db.prepare("SELECT id, address FROM messages WHERE id = ?");
  const deleteMessage = db.prepare("DELETE FROM messages WHERE id = ?");
  const pruneMessages = db.prepare(
    "DELETE FROM messages WHERE address = ? AND id NOT IN (SELECT id FROM messages WHERE address = ? ORDER BY id DESC LIMIT ?)"
  );
  const sweepMessages = db.prepare("DELETE FROM messages WHERE created_at < ?");

  return {
    kind: "sqlite",
    async getAddress(address) { return getAddress.get(address); },
    async insertAddress(address, publicKey, tokenHash, createdAt) {
      insertAddress.run(address, publicKey, tokenHash, createdAt);
    },
    async updatePubkey(publicKey, address) { updatePubkey.run(publicKey, address); },
    async deleteAddress(address) { deleteAddress.run(address); },
    async insertMessage(address, sender, ephPubkey, nonce, ciphertext, createdAt) {
      const info = insertMessage.run(address, sender, ephPubkey, nonce, ciphertext, createdAt);
      return { lastInsertRowid: Number(info.lastInsertRowid) };
    },
    async listMessages(address, since) { return listMessages.all(address, since); },
    async getMessage(id) { return getMessage.get(id); },
    async deleteMessage(id) { deleteMessage.run(id); },
    // Retention: keep only the newest `keepNewest` messages per address.
    async pruneMessages(address, keepNewest) { pruneMessages.run(address, address, keepNewest); },
    // Retention: delete messages older than an ISO timestamp (lazy sweep).
    async sweepMessagesOlderThan(cutoffIso) { sweepMessages.run(cutoffIso); },
    // Test-only: raw row dump for the no-plaintext-at-rest check.
    async rawMessages() { return db.prepare("SELECT * FROM messages").all(); },
    close() { try { db.close(); } catch { /* already closed */ } },
  };
}

export function nowIso() {
  return new Date().toISOString();
}
