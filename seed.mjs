// Seed demo data: two demo addresses with an encrypted thread between them.
// DEMO ONLY — keys are written to ./demo/ in the clear so they can be pasted
// into the web UI. Never use these addresses for anything real.
//
// Usage: node src/server.js &  then  node seed.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeypair, encryptEnvelope } from "./src/crypto.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const URL = process.env.RELAY_URL || "http://127.0.0.1:8787";
const DEMO_DIR = path.join(__dirname, "demo");

async function api(method, p, body, token) {
  const res = await fetch(URL + p, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function register(address) {
  const kp = generateKeypair();
  const { status, json } = await api("POST", "/v1/addresses", {
    address,
    public_key: kp.publicKeySpkiB64,
  });
  if (status === 409) {
    console.error(`address ${address} already registered.`);
    console.error("To reseed: stop the server, delete data/relay.db* and start again.");
    process.exit(1);
  }
  if (status !== 201) {
    console.error(`register ${address} failed:`, json);
    process.exit(1);
  }
  return { ...kp, address, owner_token: json.owner_token };
}

async function send(from, to, toPub, subject, body, thread_id) {
  const env = encryptEnvelope(toPub, { subject, body, thread_id });
  const { status, json } = await api("POST", `/v1/inbox/${to}/messages`, { from, ...env });
  if (status !== 201) {
    console.error(`send ${from} -> ${to} failed:`, json);
    process.exit(1);
  }
}

const health = await api("GET", "/healthz");
if (health.status !== 200) {
  console.error(`server not reachable at ${URL} (start it with: node src/server.js)`);
  process.exit(1);
}

const alice = await register("alice@relay");
const bob = await register("bob@relay");

await send("alice@relay", "bob@relay", bob.publicKeySpkiB64,
  "Welcome to Agent Relay",
  "Hey Bob — this is Agent Relay. Every message here is sealed end-to-end: the server only ever sees ciphertext.\n\nTry the New message button, or hit Reply.",
  "thread-welcome");
await send("bob@relay", "alice@relay", alice.publicKeySpkiB64,
  "Re: Welcome to Agent Relay",
  "Got it, Alice. Store-and-forward beats polling — I picked this up whenever I came online, no rendezvous needed.\n\nHit Reply under a message to keep the thread going.",
  "thread-welcome");
await send("alice@relay", "bob@relay", bob.publicKeySpkiB64,
  "How encryption works here",
  "Quick recap of the crypto, since you asked:\n\n- Each address owns a P-256 ECDH keypair, made in your browser.\n- Sending generates an ephemeral keypair, ECDH -> HKDF-SHA256 -> AES-256-GCM.\n- The server stores {from, to, ephemeral_pubkey, nonce, ciphertext} and nothing else.\n\nForward secrecy per message: each envelope uses a fresh ephemeral key.",
  "thread-crypto");

fs.mkdirSync(DEMO_DIR, { recursive: true });
for (const who of [alice, bob]) {
  const fp = path.join(DEMO_DIR, `${who.address.split("@")[0]}.key.json`);
  fs.writeFileSync(fp, JSON.stringify({
    _warning: "DEMO ONLY - these keys are public fixtures, never use for real messages",
    private_key: who.privateKeyPkcs8B64,
    public_key: who.publicKeySpkiB64,
    address: who.address,
    owner_token: who.owner_token,
  }, null, 2) + "\n", { mode: 0o600 });
  console.log(`wrote ${fp}`);
}

console.log(`
Seeded demo mailboxes:
  alice@relay <-> bob@relay (3 messages, 2 threads)

To view in the web UI: open http://127.0.0.1:8787, choose "Import key",
and paste the contents of demo/alice.key.json (or bob).
`);
