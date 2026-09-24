import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function wrap(db) {
  const rawPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const stmt = rawPrepare(sql);
    const origRun = stmt.run.bind(stmt);
    stmt.run = (...args) => {
      const info = origRun(...args);
      return {
        ...info,
        lastInsertRowid: Number(info.lastInsertRowid),
        changes: Number(info.changes),
      };
    };
    return stmt;
  };
  db.transaction = (fn) => {
    return (...args) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = fn(...args);
        db.exec("COMMIT");
        return result;
      } catch (err) {
        try { db.exec("ROLLBACK"); } catch { /* ignore */ }
        throw err;
      }
    };
  };
  const rawClose = db.close.bind(db);
  db.close = () => {
    try { rawClose(); } catch { /* already closed */ }
  };
  return db;
}

export function openDb(dbPath) {
  if (dbPath !== ":memory:") {
    const dir = path.dirname(dbPath);
    if (dir && dir !== ".") fs.mkdirSync(dir, { recursive: true });
  }
  const db = wrap(new DatabaseSync(dbPath));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

export function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS boxes (
      id TEXT PRIMARY KEY,
      read_key_hash TEXT NOT NULL,
      write_key_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_activity_at TEXT NOT NULL,
      retention_days INTEGER,
      title TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      box_id TEXT NOT NULL,
      client_msg_id TEXT,
      sender TEXT NOT NULL,
      recipient TEXT,
      reply_to INTEGER,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (box_id) REFERENCES boxes(id) ON DELETE CASCADE,
      FOREIGN KEY (reply_to) REFERENCES messages(id) ON DELETE SET NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client
      ON messages(box_id, client_msg_id)
      WHERE client_msg_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_messages_box_id
      ON messages(box_id, id);

    CREATE TABLE IF NOT EXISTS tombstones (
      id TEXT PRIMARY KEY,
      deleted_at TEXT NOT NULL
    );

    -- Share grants: single-link access for humans. A grant is a bearer
    -- token (gt_…) that reads and writes chat messages on one box, but
    -- cannot delete the box or rotate grants. The token travels in the
    -- URL fragment so it never reaches server logs.
    CREATE TABLE IF NOT EXISTS grants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      box_id TEXT NOT NULL,
      label TEXT,
      token_hash TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'chat',
      created_at TEXT NOT NULL,
      revoked_at TEXT,
      FOREIGN KEY (box_id) REFERENCES boxes(id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_grants_token
      ON grants(token_hash);

    CREATE INDEX IF NOT EXISTS idx_grants_box
      ON grants(box_id);

    CREATE INDEX IF NOT EXISTS idx_boxes_last_activity
      ON boxes(last_activity_at);
  `);
}

export function nowIso() {
  return new Date().toISOString();
}

export function addDaysIso(iso, days) {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

export function isExpired(box, defaultRetentionDays, at = new Date()) {
  const days = box.retention_days ?? defaultRetentionDays;
  const last = new Date(box.last_activity_at);
  const expiry = new Date(last.getTime() + days * 24 * 60 * 60 * 1000);
  return at >= expiry;
}

export function expiresAt(box, defaultRetentionDays) {
  const days = box.retention_days ?? defaultRetentionDays;
  return addDaysIso(box.last_activity_at, days);
}
