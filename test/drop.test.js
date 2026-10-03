import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createApp } from "../src/server.js";
import { encryptDrop, decryptDrop } from "../src/crypto.js";

const run = promisify(execFile);

/* Module 5: relay-drop — single-use encrypted links. */

describe("drop crypto", () => {
  it("round-trips", () => {
    const key = crypto.randomBytes(32);
    const packed = encryptDrop(key, { subject: "s", body: "b" });
    assert.match(packed, /^[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/);
    assert.deepEqual(decryptDrop(key, packed), { subject: "s", body: "b" });
  });

  it("wrong key fails", () => {
    const packed = encryptDrop(crypto.randomBytes(32), { body: "b" });
    assert.throws(() => decryptDrop(crypto.randomBytes(32), packed), /decryption failed/);
  });
});

describe("drop api", () => {
  let app, server, base;

  // fetch() consumes the body once; parse text then JSON from it.
  async function raw(method, p, body) {
    const res = await fetch(base + p, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = {};
    try { json = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: res.status, json, text };
  }

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

  it("create then burn-on-read; second read 404s", async () => {
    const key = crypto.randomBytes(32);
    const packed = encryptDrop(key, { subject: "hi", body: "secret msg" });
    const c = await raw("POST", "/v1/drops", { ciphertext: packed });
    assert.equal(c.status, 201);
    assert.match(c.json.id, /^[A-Za-z0-9_-]{12}$/);
    assert.ok(c.json.expires_at);

    const g1 = await raw("GET", `/v1/drops/${c.json.id}`);
    assert.equal(g1.status, 200);
    assert.equal(g1.json.ciphertext, packed);
    assert.deepEqual(decryptDrop(key, g1.json.ciphertext).body, "secret msg");

    const g2 = await raw("GET", "/v1/drops/" + c.json.id);
    assert.equal(g2.status, 404);
  });

  it("rejects bad ciphertext and oversized drops", async () => {
    const bad = await raw("POST", "/v1/drops", { ciphertext: "not-valid!!" });
    assert.equal(bad.status, 400);
    const big = await raw("POST", "/v1/drops", { ciphertext: "QUJD." + "A".repeat(70 * 1024) });
    assert.equal(big.status, 400);
  });

  it("clamps ttl_hours to 1..168", async () => {
    const key = crypto.randomBytes(32);
    const c = await raw("POST", "/v1/drops", { ciphertext: encryptDrop(key, { body: "x" }), ttl_hours: 10000 });
    assert.equal(c.status, 201);
    const exp = new Date(c.json.expires_at).getTime();
    const max = Date.now() + 168 * 3600_000 + 60_000;
    assert.ok(exp <= max, "expiry beyond 168h cap");
  });

  it("reader page serves at /d/:id", async () => {
    const r = await raw("GET", "/d/abc123XYZ_-");
    assert.equal(r.status, 200);
    assert.match(r.text, /agent relay · drop/);
  });

  it("CLI drop prints a working single-use URL", async () => {
    const out = await run("node", ["bin/relay.js", "drop", "--body", "cli secret", "--subject", "t"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, RELAY_URL: base },
    });
    const urlLine = out.stdout.split("\n")[0].trim();
    const mu = urlLine.match(/\/d\/([A-Za-z0-9_-]{12})#k=([A-Za-z0-9_-]+)$/);
    assert.ok(mu, `unexpected drop URL: ${urlLine}`);
    const key = Buffer.from(mu[2].replace(/-/g, "+").replace(/_/g, "/"), "base64");
    const g = await raw("GET", `/v1/drops/${mu[1]}`);
    assert.equal(g.status, 200);
    const dec = decryptDrop(key, g.json.ciphertext);
    assert.equal(dec.body, "cli secret");
    assert.equal(dec.subject, "t");
    const g2 = await raw("GET", `/v1/drops/${mu[1]}`);
    assert.equal(g2.status, 404);
  });
});
