import { Pool } from "@neondatabase/serverless";

// Postgres store with the same prepare()/transaction() shape as the
// SQLite store in db.js, except get()/all()/run() return Promises.
// Call sites use `await` uniformly; SQLite's sync values pass through await.

const PG_SCHEMA = `
CREATE TABLE IF NOT EXISTS boxes (
  id TEXT PRIMARY KEY,
  read_key_hash TEXT NOT NULL,
  write_key_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  last_activity_at TIMESTAMPTZ NOT NULL,
  retention_days INTEGER,
  title TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  box_id TEXT NOT NULL REFERENCES boxes(id) ON DELETE CASCADE,
  client_msg_id TEXT,
  sender TEXT NOT NULL,
  recipient TEXT,
  reply_to BIGINT REFERENCES messages(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client
  ON messages(box_id, client_msg_id)
  WHERE client_msg_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_messages_box_id
  ON messages(box_id, id);

CREATE TABLE IF NOT EXISTS tombstones (
  id TEXT PRIMARY KEY,
  deleted_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS grants (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  box_id TEXT NOT NULL REFERENCES boxes(id) ON DELETE CASCADE,
  label TEXT,
  token_hash TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'chat',
  created_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_grants_token
  ON grants(token_hash);

CREATE INDEX IF NOT EXISTS idx_grants_box
  ON grants(box_id);

CREATE INDEX IF NOT EXISTS idx_boxes_last_activity
  ON boxes(last_activity_at);
`;

// Translate SQLite `?` placeholders to Postgres `$1..$n`, skipping
// `?` characters inside quoted string literals.
function translatePlaceholders(sql) {
  let n = 0;
  let out = "";
  let quote = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (quote) {
      out += c;
      if (c === quote) {
        if (sql[i + 1] === quote) {
          out += sql[i + 1];
          i++;
        } else {
          quote = null;
        }
      }
    } else if (c === "'" || c === '"') {
      quote = c;
      out += c;
    } else if (c === "?") {
      n++;
      out += "$" + n;
    } else {
      out += c;
    }
  }
  return out;
}

// Rewrite the SQLite-isms this codebase uses.
function translateSql(sql) {
  let out = translatePlaceholders(sql);
  // Only tombstones use INSERT OR REPLACE.
  out = out.replace(/INSERT\s+OR\s+REPLACE\s+INTO\s+tombstones/i,
    "INSERT INTO tombstones");
  if (/INSERT\s+INTO\s+tombstones/i.test(out) && !/ON\s+CONFLICT/i.test(out)) {
    out += " ON CONFLICT (id) DO UPDATE SET deleted_at = EXCLUDED.deleted_at";
  }
  return out;
}

// Normalize pg row values to match the SQLite store's shapes:
// TIMESTAMPTZ -> ISO string, BIGINT/int8 count strings -> Number.
function normalize(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
  return value;
}

function normalizeRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) out[k] = normalize(v);
  return out;
}

// pg unique-violation -> the code the routes already handle.
function mapError(err) {
  if (err && err.code === "23505") {
    err.code = "SQLITE_CONSTRAINT_UNIQUE";
  }
  throw err;
}

export function openPg(connectionString) {
  const pool = new Pool({ connectionString, max: 5 });
  pool.on("error", () => {
    // Idle client errors (e.g. DB auto-suspend) must not crash the process.
  });

  // Transaction client routing: prepare() is called fresh at each use
  // site, so statements created inside db.transaction() see the tx
  // client via this binding at execution time.
  let txClient = null;
  const target = () => txClient ?? pool;

  function prepare(sql) {
    const pgSql = translateSql(sql);
    return {
      async get(...params) {
        try {
          const r = await target().query(pgSql, params);
          return r.rows.length ? normalizeRow(r.rows[0]) : undefined;
        } catch (err) {
          mapError(err);
        }
      },
      async all(...params) {
        try {
          const r = await target().query(pgSql, params);
          return r.rows.map(normalizeRow);
        } catch (err) {
          mapError(err);
        }
      },
      async run(...params) {
        try {
          let q = pgSql;
          if (/^\s*insert\s+/i.test(q) && !/returning\s+/i.test(q)) {
            q += " RETURNING id";
          }
          const r = await target().query(q, params);
          const row = r.rows[0];
          return {
            lastInsertRowid: row && row.id != null ? Number(row.id) : 0,
            changes: typeof r.rowCount === "number" ? r.rowCount : 0,
          };
        } catch (err) {
          mapError(err);
        }
      },
    };
  }

  function transaction(fn) {
    return async (...args) => {
      const client = await pool.connect();
      const prev = txClient;
      txClient = client;
      try {
        await client.query("BEGIN");
        const result = await fn(...args);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // ignore
        }
        throw err;
      } finally {
        txClient = prev;
        client.release();
      }
    };
  }

  return {
    prepare,
    transaction,
    isAsync: true,
    async migrate() {
      await pool.query(PG_SCHEMA);
    },
    async close() {
      await pool.end();
    },
  };
}
