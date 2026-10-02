import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createApp } from "../src/server.js";
import { openSqliteDb, nowIso } from "../src/db.js";
import { generateKeypair, encryptEnvelope } from "../src/crypto.js";

/* Module 1: relay-retention — the server bounds per-address storage. */

describe("adapter retention", () => {
  it("pruneMessages keeps only the newest N per address", async () => {
    const db = openSqliteDb(":memory:");
    await db.insertAddress("a@relay", "pk", "hash", nowIso());
    await db.insertAddress("b@relay", "pk", "hash", nowIso());
    for (let i = 0; i < 5; i++) {
      await db.insertMessage("a@relay", "s@relay", "e", "n", "c" + i, nowIso());
    }
    await db.insertMessage("b@relay", "s@relay", "e", "n", "other", nowIso());
    await db.pruneMessages("a@relay", 3);
    const a = await db.listMessages("a@relay", 0);
    assert.equal(a.length, 3);
    assert.deepEqual(a.map((m) => m.ciphertext), ["c2", "c3", "c4"]);
    // Other addresses untouched.
    assert.equal((await db.listMessages("b@relay", 0)).length, 1);
    db.close();
  });

  it("sweepMessagesOlderThan removes only expired rows", async () => {
    const db = openSqliteDb(":memory:");
    await db.insertAddress("a@relay", "pk", "hash", nowIso());
    const old = new Date(Date.now() - 40 * 86400_000).toISOString();
    await db.insertMessage("a@relay", "s@relay", "e", "n", "old", old);
    await db.insertMessage("a@relay", "s@relay", "e", "n", "new", nowIso());
    const cutoff = new Date(Date.now() - 30 * 86400_000).toISOString();
    await db.sweepMessagesOlderThan(cutoff);
    const rows = await db.listMessages("a@relay", 0);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].ciphertext, "new");
    db.close();
  });
});

describe("server retention", () => {
  let app, server, base;
  const kp = generateKeypair();
  let token;

  async function req(method, p, body, tok) {
    const res = await fetch(base + p, {
      method,
      headers: {
        "content-type": "application/json",
        ...(tok ? { authorization: `Bearer ${tok}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  }

  before(async () => {
    app = createApp({ dbPath: ":memory:", maxMsgsPerAddress: 3, msgTtlDays: 0 });
    server = http.createServer(app.handler);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}`;
    const reg = await req("POST", "/v1/addresses", { address: "cap@relay", public_key: kp.publicKeySpkiB64 });
    token = reg.json.owner_token;
  });

  after(async () => {
    await new Promise((r) => server.close(r));
    app.close();
  });

  it("send beyond the cap evicts the oldest", async () => {
    for (let i = 0; i < 5; i++) {
      const env = encryptEnvelope(kp.publicKeySpkiB64, { subject: "s" + i, body: "b" + i });
      const snd = await req("POST", "/v1/inbox/cap@relay/messages", { from: "sender@relay", ...env });
      assert.equal(snd.status, 201);
    }
    const inbox = await req("GET", "/v1/inbox/cap@relay/messages", undefined, token);
    assert.equal(inbox.json.messages.length, 3);
  });

  it("cap of 0 disables pruning", async () => {
    const app2 = createApp({ dbPath: ":memory:", maxMsgsPerAddress: 0, msgTtlDays: 0 });
    const s2 = http.createServer(app2.handler);
    try {
      await new Promise((r) => s2.listen(0, "127.0.0.1", r));
      const b2 = `http://127.0.0.1:${s2.address().port}`;
      const reg = await fetch(b2 + "/v1/addresses", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: "nocap@relay", public_key: kp.publicKeySpkiB64 }),
      }).then((r) => r.json());
      for (let i = 0; i < 4; i++) {
        const env = encryptEnvelope(kp.publicKeySpkiB64, { subject: "s", body: "b" });
        await fetch(b2 + "/v1/inbox/nocap@relay/messages", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ from: "sender@relay", ...env }),
        });
      }
      const inbox = await fetch(b2 + "/v1/inbox/nocap@relay/messages", {
        headers: { authorization: `Bearer ${reg.owner_token}` },
      }).then((r) => r.json());
      assert.equal(inbox.messages.length, 4);
    } finally {
      await new Promise((r) => s2.close(r));
      app2.close();
    }
  });
});
