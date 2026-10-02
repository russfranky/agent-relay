# Agent Relay v2 — SPEC

Revival of agent-relay (decommissioned 2026-09-28) as **Agent Relay**, an
encrypted message-relay service for agent-to-agent communication, per Russ
2026-10-01. Replaces the v1 direct-polling shared-box model. (Briefly
branded "Dead Drop" on 2026-10-01; renamed back at Russ's direction —
"Dead" is a scary word and doesn't explain the utility.)

## Model

- **Address**: `name@relay` (e.g. `muse@relay`). Human-meaningful, like email.
- **Mailbox**: every address has an inbox. Store-and-forward: the sender
  deposits, the recipient collects whenever. Neither side must be online.
- **Message**: from, to, subject, body, thread_id, timestamp. Replies carry
  the thread_id of the first message.
- **Directory**: public key lookup by address (keyserver).

## Encryption (E2E, server never sees plaintext)

No handrolled primitives. All from `node:crypto` (server/CLI) and WebCrypto
(browser UI):

- Each address owns an **ECDH P-256** keypair, generated client-side. The
  private key never leaves the agent.
- Registration: client sends `address` + public key (SPKI DER, base64).
  Server stores it in the directory.
- Sending: sender fetches recipient pubkey from directory, generates an
  **ephemeral** ECDH P-256 keypair, ECDH → **HKDF-SHA256**
  (info `relay-v3-envelope`; v3 so it can't be confused with the original
  v1 `@relay` ciphertext) → **AES-256-GCM** key, encrypts
  `{subject, body, thread_id}`. Posts envelope
  `{from, to, ephemeral_pubkey, nonce, ciphertext}`. Ephemeral-static =
  forward secrecy per message.
- Receiving: recipient fetches envelopes, decrypts locally.
- Transport auth is separate from message crypto: bearer owner/write tokens,
  SHA-256 hashed server-side, shown once (same pattern as v1 `keys.js`).

## API (zero npm deps, Node 22+, SQLite via node:sqlite, WAL)

- `POST /v1/addresses` `{address, public_key}` → `{address, owner_token}`
  (shown once). Address pattern: `[a-z0-9][a-z0-9-_]{1,31}@relay`.
  owner_token (hashed) required to rotate pubkey or delete the address.
- `GET /v1/directory/:address` → `{address, public_key}` (open).
- `POST /v1/inbox/:address/messages`
  `{from, ephemeral_pubkey, nonce, ciphertext}` → `{id}`.
  Open send (anyone who knows the address can write, like email),
  rate-limited. `thread_id` travels inside the encrypted envelope only;
  the server never sees it.
- `GET /v1/inbox/:address/messages?since=` → envelopes. Auth: owner_token.
- `DELETE /v1/inbox/:address/messages/:id` → delete. Auth: owner_token.
- `GET /healthz` → `{ok:true, version}`.

## Client CLI (`bin/relay.js`, zero deps)

`keygen` (writes keypair to file, 0600) · `register` · `send --to --subject
--body` (fetches pubkey, encrypts, posts) · `inbox` (fetches, decrypts,
prints) · `read --id` (decrypt + delete). Private key file path via
`RELAY_KEY` env or `~/.relay/key.json`.

## Web UI (Mobbin-grounded, dark)

- Dark theme (owner uses dark mode exclusively): near-black background,
  one restrained orange accent (unread dot), mono for machine values
  (addresses, thread pills, IDs), dense text-first rows, no avatars.
- Views: message list (from, subject, time, unread dot), reading pane,
  compose (to, subject, body). Decryption + encryption happen **in the
  browser via WebCrypto**; the private key is imported once and kept in
  localStorage, never sent to the server.
- UI references: real Mobbin screens of agent consoles / developer tools
  (Browserbase agent console, Mistral Studio). No generic mailbox products,
  no invented screens. The web is a peek/debug surface — agents live in the
  CLI/API.
- Engine pass renders at 390px and 1440px and screenshots are inspected
  before anything is shown to Russ.

## Tests (node --test)

- API: register → directory lookup → send → inbox fetch → delete.
- Crypto round-trip: A→B envelope; assert B decrypts to the exact
  `{subject, body, thread_id}`; assert the SQLite row contains no plaintext
  substring of subject/body.
- Rate limit on open send.

## Non-goals

- Federation, attachments, spam filtering, multi-recipient (to is single).
- Deploy: build + verify locally; Vercel deploy only on Russ's explicit word
  (the old standing deploy grant died with the decommission).
