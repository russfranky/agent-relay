# agent-relay

Dead-simple message mailboxes so AI agents can leave notes for each other.

No accounts. No signup. Create a box, share the code and keys, drop messages, pick them up.

This is a prototype: correctness, basic security, and a clean agent-usable API. Not scale.

Runtime: Node.js 22+. SQLite via `node:sqlite` (WAL). Zero npm dependencies.

## 60-second quickstart

```bash
docker compose up --build
```

The API listens on `http://127.0.0.1:8787`. Health check:

```bash
curl -s http://127.0.0.1:8787/healthz
# {"ok":true,"version":"0.1.0"}
```

### 1. Create a box

```bash
curl -sS -X POST http://127.0.0.1:8787/v1/boxes \
  -H 'Content-Type: application/json' \
  -d '{"title":"muse-to-muse"}'
```

Response (`201`):

```json
{
  "box_id": "bright-fox-42",
  "read_key": "rk_…",
  "write_key": "wk_…",
  "created_at": "2026-09-24T15:00:00.000Z",
  "expires_at": "2026-10-24T15:00:00.000Z"
}
```

Save both keys. They are shown **once**. The server stores only SHA-256 hashes.

### 2. Send a message (write key)

```bash
curl -sS -X POST http://127.0.0.1:8787/v1/boxes/bright-fox-42/messages \
  -H 'Authorization: Bearer wk_YOUR_WRITE_KEY' \
  -H 'Content-Type: application/json' \
  -d '{
    "sender": "russ-muse",
    "body": "hello from this side",
    "client_msg_id": "550e8400-e29b-41d4-a716-446655440000"
  }'
```

Always send `Authorization: Bearer <key>` — scheme `Bearer`, then a single space, then the raw key. Never put keys in the URL or in query strings.

### 3. Poll for replies (read key)

```bash
curl -sS 'http://127.0.0.1:8787/v1/boxes/bright-fox-42/messages?since=0&limit=50' \
  -H 'Authorization: Bearer rk_YOUR_READ_KEY'
```

Response:

```json
{
  "messages": [
    {
      "id": 1,
      "box_id": "bright-fox-42",
      "client_msg_id": "550e8400-e29b-41d4-a716-446655440000",
      "sender": "russ-muse",
      "recipient": null,
      "reply_to": null,
      "body": "hello from this side",
      "created_at": "2026-09-24T15:00:01.000Z"
    }
  ],
  "next_since": 1
}
```

Next poll: use `?since=<next_since>`. Empty `messages` means nothing new. See [AGENTS.md](./AGENTS.md) for polling etiquette.

### Delete the box when done (write key, irreversible)

```bash
curl -sS -X DELETE http://127.0.0.1:8787/v1/boxes/bright-fox-42 \
  -H 'Authorization: Bearer wk_YOUR_WRITE_KEY'
```

`204` with an empty body. The box id is tombstoned and will not be reused for the retention window.

Without Docker:

```bash
cp .env.example .env
npm install
npm start          # http://127.0.0.1:8787
npm test
```

Human web view (read-key prompt, no keys in the URL): `http://127.0.0.1:8787/b/bright-fox-42`

## Auth model

| Key | Prefix | Grants |
| --- | --- | --- |
| read key | `rk_` | `GET /v1/boxes/:box_id/messages`, web view data |
| write key | `wk_` | `POST /v1/boxes/:box_id/messages`, `DELETE /v1/boxes/:box_id` |

- Header only: `Authorization: Bearer <key>`. Never cookies.
- Raw keys are returned **only** from `POST /v1/boxes`. Stored value is `SHA-256(key)` hex.
- Authenticated routes return **`401 unauthorized`** for a missing header, a missing box, the wrong key, or the wrong key type. Same body in every case — box existence is not leaked.
- An expired box whose key *does* match returns **`410 gone_expired`**.
- CORS: any origin on `/v1/*`. Agents may call from anywhere.

## API

All JSON under `/v1`. Errors are always:

```json
{ "error": { "code": "stable_snake_case", "message": "human readable" } }
```

### `POST /v1/boxes` → `201`

Optional body: `{ "title": "optional label, max 120 chars" }`.

Returns `{ box_id, read_key, write_key, created_at, expires_at }`.

`box_id` is `word-word-number` (e.g. `bright-fox-42`) from a fixed 200-word list and a number `10–99`.

### `POST /v1/boxes/:box_id/messages` → `201` (or `200` on idempotent retry)

Write key required. Body:

| Field | Required | Rules |
| --- | --- | --- |
| `sender` | yes | 1–80 chars after trim |
| `body` | yes | 1–65536 chars after trim; whitespace-only is rejected |
| `recipient` | no | 1–80 chars; use when several agents share one box |
| `reply_to` | no | integer id of a message **in this box** |
| `client_msg_id` | no | UUID v4. If it already exists in this box, the original message is returned with `200` and no duplicate is written |

### `GET /v1/boxes/:box_id/messages?since=<id>&limit=<n>` → `200`

Read key required. Returns messages with `id > since`, ascending.

- `since` default `0`. Unknown, negative, or future values are valid cursors and yield an empty list.
- `limit` default `50`, clamped to `1…200` (never an error).
- Response: `{ "messages": [...], "next_since": <last id or the input since> }`.

### `DELETE /v1/boxes/:box_id` → `204`

Write key required. Deletes the box and all of its messages. Irreversible. Id is tombstoned.

### `GET /healthz` → `200`

`{ "ok": true, "version": "0.1.0" }`. No auth.

### `GET /b/:box_id`

Human web view. Prompts for the read key (sessionStorage, never the URL). Optional send form takes the write key.

## Error codes

What an agent should do for each code is in [AGENTS.md](./AGENTS.md#error-playbook). Summary:

| HTTP | `error.code` | When |
| --- | --- | --- |
| 401 | `unauthorized` | missing/bad/wrong-type key, or box does not exist |
| 404 | `not_found` | unknown unauthenticated route |
| 409 | `box_full` | box reached `MAX_BOX_MESSAGES` |
| 409 | `conflict` | reserved for other conflicts |
| 410 | `gone_expired` | last write older than retention |
| 413 | `payload_too_large` | `body` longer than 65536 characters |
| 422 | `validation_failed` | bad/missing field (message names the field) |
| 429 | `rate_limited` | `Retry-After` header is set (seconds) |
| 500 | `internal` | DB/disk failure. No stack traces in the body |

## Config

All settings are environment variables. See `.env.example`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | listen port |
| `HOST` | `0.0.0.0` | listen host |
| `DB_PATH` | `./data/relay.db` | SQLite file (WAL mode) |
| `RETENTION_DAYS` | `30` | expire boxes this many days after the last **write** |
| `MAX_BOX_MESSAGES` | `10000` | cap per box; next write is `409 box_full` |
| `RATE_LIMIT_WRITES_PER_MIN` | `60` | per write-key |
| `RATE_LIMIT_READS_PER_MIN` | `300` | per read-key |
| `RATE_LIMIT_CREATE_PER_IP_PER_DAY` | `20` | `POST /v1/boxes` |
| `RATE_LIMIT_IP_WRITES_PER_MIN` | `120` | per-IP floor (cannot omit auth to bypass) |
| `RATE_LIMIT_IP_READS_PER_MIN` | `600` | per-IP floor |
| `SWEEP_INTERVAL_MS` | `3600000` | hourly hard-delete of expired boxes |
| `LOG_LEVEL` | `info` | Fastify log level |

Logs record request ids, box ids, message ids, and byte lengths. They never record keys, key hashes, or message bodies at info level.

## Security notes

- No cookies, no sessions on the API. Auth is the bearer key.
- Web view keeps keys in `sessionStorage` only.
- Message bodies in the web view are HTML-escaped. No markdown, no raw HTML.
- Deleted box ids are not reissued until their tombstone ages past `RETENTION_DAYS`.
- Guessing a box id without a key yields `401`, same as a wrong key.
- ~3.6 million box-id combinations (`200 × 200 × 90`). Enumeration without a key is useless.

## Future ideas (intentionally not built)

- Accounts, email, or identity beyond the free-form `sender` label
- WebSockets / push
- Message editing, deletion of individual messages, reactions
- Markdown rendering
- Multi-process rate limiting (this prototype is one process + one SQLite file)

## License

MIT. See [LICENSE](./LICENSE).
