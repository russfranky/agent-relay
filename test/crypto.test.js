import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import {
  generateKeypair,
  encryptEnvelope,
  decryptEnvelope,
  parseSpkiPublicKey,
} from "../src/crypto.js";
import { createApp } from "../src/server.js";

// WebCrypto side, mirroring web/app.js exactly.
const wc = crypto.webcrypto;
const HKDF_INFO = new TextEncoder().encode("relay-v3-envelope");
const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const bytesToB64 = (bytes) => btoa(String.fromCharCode(...bytes));

async function hkdfKey(bits) {
  const base = await wc.subtle.importKey("raw", bits, "HKDF", false, ["deriveBits"]);
  return wc.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: HKDF_INFO },
    base, 256
  );
}
async function wcEncrypt(recipientSpkiB64, payload) {
  const recPub = await wc.subtle.importKey("spki", b64ToBytes(recipientSpkiB64),
    { name: "ECDH", namedCurve: "P-256" }, false, []);
  const eph = await wc.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const bits = await wc.subtle.deriveBits({ name: "ECDH", public: recPub }, eph.privateKey, 256);
  const aesKey = await wc.subtle.importKey("raw", await hkdfKey(bits), "AES-GCM", false, ["encrypt"]);
  const nonce = wc.getRandomValues(new Uint8Array(12));
  const pt = new TextEncoder().encode(JSON.stringify(payload));
  const ct = new Uint8Array(await wc.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, pt));
  const ephSpki = new Uint8Array(await wc.subtle.exportKey("spki", eph.publicKey));
  return {
    ephemeral_pubkey: bytesToB64(ephSpki),
    nonce: bytesToB64(nonce),
    ciphertext: bytesToB64(ct),
  };
}
async function wcDecrypt(privateKeyPkcs8B64, envelope) {
  const priv = await wc.subtle.importKey("pkcs8", b64ToBytes(privateKeyPkcs8B64),
    { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const ephPub = await wc.subtle.importKey("spki", b64ToBytes(envelope.ephemeral_pubkey),
    { name: "ECDH", namedCurve: "P-256" }, false, []);
  const bits = await wc.subtle.deriveBits({ name: "ECDH", public: ephPub }, priv, 256);
  const aesKey = await wc.subtle.importKey("raw", await hkdfKey(bits), "AES-GCM", false, ["decrypt"]);
  const pt = await wc.subtle.decrypt({ name: "AES-GCM", iv: b64ToBytes(envelope.nonce) },
    aesKey, b64ToBytes(envelope.ciphertext));
  return JSON.parse(new TextDecoder().decode(pt));
}

describe("envelope crypto", () => {
  it("node encrypt -> node decrypt round-trip", () => {
    const bob = generateKeypair();
    const payload = { subject: "s3cr3t-subject", body: "s3cr3t-body-xyz", thread_id: "t-9" };
    const env = encryptEnvelope(bob.publicKeySpkiB64, payload);
    assert.deepEqual(decryptEnvelope(bob.privateKeyPkcs8B64, env), payload);
  });

  it("ephemeral keys differ per message (forward secrecy shape)", () => {
    const bob = generateKeypair();
    const a = encryptEnvelope(bob.publicKeySpkiB64, { subject: "s", body: "b" });
    const b = encryptEnvelope(bob.publicKeySpkiB64, { subject: "s", body: "b" });
    assert.notEqual(a.ephemeral_pubkey, b.ephemeral_pubkey);
    assert.notEqual(a.ciphertext, b.ciphertext);
  });

  it("wrong private key fails to decrypt", () => {
    const bob = generateKeypair();
    const mallory = generateKeypair();
    const env = encryptEnvelope(bob.publicKeySpkiB64, { subject: "s", body: "b" });
    assert.throws(() => decryptEnvelope(mallory.privateKeyPkcs8B64, env), /decryption failed/);
  });

  it("node encrypt -> WebCrypto decrypt", async () => {
    const bob = generateKeypair();
    const payload = { subject: "cross-a", body: "cross-b", thread_id: null };
    const env = encryptEnvelope(bob.publicKeySpkiB64, payload);
    assert.deepEqual(await wcDecrypt(bob.privateKeyPkcs8B64, env), payload);
  });

  it("WebCrypto encrypt -> node decrypt", async () => {
    const bob = generateKeypair();
    const payload = { subject: "cross-c", body: "cross-d", thread_id: "t-x" };
    const env = await wcEncrypt(bob.publicKeySpkiB64, payload);
    assert.deepEqual(decryptEnvelope(bob.privateKeyPkcs8B64, env), payload);
  });

  it("rejects non-P-256 public keys", () => {
    const { publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "secp384r1" });
    const b64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
    assert.throws(() => parseSpkiPublicKey(b64), /not P-256/);
  });
});

describe("no plaintext at rest", () => {
  let app, server, base;
  const SUBJECT = "no-plaintext-subject-ZZ9Q";
  const BODY = "no-plaintext-body-KK7M-lorem-ipsum-dolor";

  before(async () => {
    app = createApp({ dbPath: ":memory:" });
    server = http.createServer(app.handler);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    await new Promise((r) => server.close(r));
    app.close();
  });

  it("SQLite row contains no plaintext substring of subject/body", async () => {
    const bob = generateKeypair();
    let res = await fetch(base + "/v1/addresses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: "bob@relay", public_key: bob.publicKeySpkiB64 }),
    });
    assert.equal(res.status, 201);

    const env = encryptEnvelope(bob.publicKeySpkiB64, {
      subject: SUBJECT,
      body: BODY,
      thread_id: "thread-secret-42",
    });
    res = await fetch(base + "/v1/inbox/bob@relay/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "alice@relay", ...env }),
    });
    assert.equal(res.status, 201);

    // Dump every stored column for this mailbox straight from SQLite.
    const rows = await app.db.rawMessages();
    assert.equal(rows.length, 1);
    const blob = JSON.stringify(rows[0]);
    for (const secret of [SUBJECT, BODY, "thread-secret-42", "lorem-ipsum-dolor"]) {
      assert.ok(!blob.includes(secret), `plaintext leaked in DB row: ${secret}`);
    }
    // The sender address is header metadata (like email) and is intentionally plaintext.
    assert.ok(blob.includes("alice@relay"));
  });
});

describe("rate limit on open send", () => {
  let app, server, base;

  before(async () => {
    app = createApp({ dbPath: ":memory:", sendLimit: 3, sendWindowMs: 60_000 });
    server = http.createServer(app.handler);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}`;
    const bob = generateKeypair();
    const reg = await fetch(base + "/v1/addresses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: "vic@relay", public_key: bob.publicKeySpkiB64 }),
    });
    assert.equal(reg.status, 201);
    app._victimKey = bob.publicKeySpkiB64;
  });
  after(async () => {
    await new Promise((r) => server.close(r));
    app.close();
  });

  it("4th rapid send -> 429 with retry-after", async () => {
    const send = () => {
      const env = encryptEnvelope(app._victimKey, { subject: "spam", body: "spam" });
      return fetch(base + "/v1/inbox/vic@relay/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: "spammer@relay", ...env }),
      }).then((r) => r.status);
    };
    const statuses = [await send(), await send(), await send(), await send()];
    assert.deepEqual(statuses.slice(0, 3), [201, 201, 201]);
    assert.equal(statuses[3], 429);
    const res = await fetch(base + "/v1/inbox/vic@relay/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "spammer@relay", ...encryptEnvelope(app._victimKey, { subject: "x", body: "y" }) }),
    });
    assert.ok(res.headers.get("retry-after"), "expected retry-after header");
  });
});
