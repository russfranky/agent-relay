# agent-relay

Dead-simple message mailboxes so AI agents can leave notes for each other,
and share links so humans can chat with no account and no app.

No accounts. No signup. Create a box, share the code and keys, drop messages, pick them up.
For a human buddy: make one link, send it, start talking.

This is a prototype: correctness, basic security, and a clean agent-usable API. Not scale.

Runtime: Node.js 22+. SQLite via `node:sqlite` (WAL) locally; Postgres via
`@neondatabase/serverless` when `DATABASE_URL` is set (production). That is the
only npm dependency; the HTTP layer is a small built-in framework.

## For humans: one link, no coding

Open the landing page, type a chat name, hit **Create chat link**. You get a
link like `https://agent-relay-mu.vercel.app/c/bright-fox-42#g=gt_...`. Text or
email it to your buddy. They open it, pick a display name, and you are talking.
Messages appear live. No accounts, no app to install, nothing to configure.

The secret part lives after the `#`, so it never reaches the server in the URL
and never shows up in server logs. Anyone with the link can read and write, so
share it like you would a private photo album. Chats expire after 30 days
without a message. The chat owner keeps the write key (shown once) for the
owner controls: make a fresh link (revokes the old one) or delete the chat.

## 60-second quickstart

```bash
docker compose up --build
```

The API listens on `http://127.0.0.1:8787`. Health check:

```bash
curl -s http://127.0.0.1:8787/healthz
# {"ok":true,"version":"0.2.0"}
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
  "share_url": "/c/bright-fox-42#g=gt_…",
  "created_at": "2026-09-24T15:00:00.000Z",
  "expires_at": "2026-10-24T15:00:00.000Z"
}
```

Save both keys. They are shown **once**. The server stores only SHA-256 hashes.
`share_url` is the human invite link: send it to a buddy, they open it and chat.
Optional body: `{ "title": "..." }`. Box ids are always random `word-word-number`
codes — nothing to squat on, nothing to remember.

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

### 3. Wait for replies without polling (read key)

```bash
curl -sS 'http://127.0.0.1:8787/v1/boxes/bright-fox-42/messages?since=1&wait=25' \
  -H 'Authorization: Bearer rk_YOUR_READ_KEY'
```

`wait=<seconds>` holds the request open until a new message lands (or the
window expires, max 30 seconds). The response shape is the same as a normal
read. Loop on `next_since`: one request per reply, no empty polls. See
[AGENTS.md](./AGENTS.md) for agent etiquette.

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

Human chat pages: `/c/:box_id` (chat UI, grant in the URL fragment) and the landing page `/`.

## Auth model

| Key | Prefix | Grants |
| --- | --- | --- |
| read key | `rk_` | `GET /v1/boxes/:box_id/messages` |
| write key | `wk_` | everything the read key grants, plus `POST /v1/boxes/:box_id/messages`, `POST /v1/boxes/:box_id/share/rotate`, `DELETE /v1/boxes/:box_id` |
| share grant | `gt_` | read and write chat messages for one box only. Cannot rotate the invite or delete the box. Lives in the share-link fragment (`/c/:box_id#g=gt_…`), sent as a Bearer token by the chat page |

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

Returns `{ box_id, read_key, write_key, share_url, created_at, expires_at }`.
`share_url` is the human invite link (`/c/:box_id#g=gt_…`); minting it is atomic
with the box.

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

### `GET /v1/boxes/:box_id/messages?since=<id>&limit=<n>&wait=<s>` → `200`

Read key (or share grant) required. Returns messages with `id > since`, ascending.

- `since` default `0`. Unknown, negative, or future values are valid cursors and yield an empty list.
- `limit` default `50`, clamped to `1…200` (never an error).
- `wait` default `0`. With `wait=25`, the request holds open until a message lands or 25 seconds pass (clamped to 30). This replaces polling: loop on `next_since` and you make one request per reply.
- Response: `{ "messages": [...], "next_since": <last id or the input since> }`.

### `POST /v1/boxes/:box_id/share/rotate` → `200`

Write key required. Revokes every active share grant and mints a fresh
`share_url`. The old invite link stops working immediately. Use it if a link
leaks to the wrong person.

### `DELETE /v1/boxes/:box_id` → `204`

Write key required. Deletes the box and all of its messages. Irreversible. Id is tombstoned.

### `GET /healthz` → `200`

`{ "ok": true, "version": "0.2.0" }`. No auth.

### `GET /c/:box_id`

Human chat page. The share grant travels in the URL fragment (`#g=gt_…`), which
the browser never sends to the server; page JavaScript sends it as a Bearer
token. `/c/:box_id/info` returns the chat title and needs the grant too.

## Error codes

What an agent should do for each code is in [AGENTS.md](./AGENTS.md#error-playbook). Summary:

| HTTP | `error.code` | When |
| --- | --- | --- |
| 401 | `unauthorized` | missing/bad/wrong-type key, or box does not exist |
| 404 | `not_found` | unknown unauthenticated route |
| 409 | `box_full` | box reached `MAX_BOX_MESSAGES` |
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
| `LOG_LEVEL` | `info` | log level |

Logs record request ids, box ids, message ids, and byte lengths. They never record keys, key hashes, or message bodies at info level.

## Security notes

- No cookies, no sessions on the API. Auth is the bearer key.
- The chat page keeps the grant in the URL fragment (never sent to the server) and the display name in `localStorage` only.
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
