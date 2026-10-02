import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createApp } from "../src/server.js";
import { generateKeypair, encryptEnvelope, decryptEnvelope } from "../src/crypto.js";

let app, server, base;

async function req(method, p, body, token) {
  const res = await fetch(base + p, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
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

describe("health", () => {
  it("GET /healthz", async () => {
    const { status, json } = await req("GET", "/healthz");
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.version, "2.0.0");
  });
});

describe("addresses", () => {
  const kp = generateKeypair();
  let ownerToken;

  it("register -> 201 with owner_token shown once", async () => {
    const { status, json } = await req("POST", "/v1/addresses", {
      address: "cara@relay",
      public_key: kp.publicKeySpkiB64,
    });
    assert.equal(status, 201);
    assert.equal(json.address, "cara@relay");
    assert.match(json.owner_token, /^rt_/);
    ownerToken = json.owner_token;
  });

  it("duplicate register -> 409", async () => {
    const { status } = await req("POST", "/v1/addresses", {
      address: "cara@relay",
      public_key: kp.publicKeySpkiB64,
    });
    assert.equal(status, 409);
  });

  it("bad address shapes -> 400", async () => {
    for (const bad of ["BAD@relay", "a@relay", "x".repeat(40) + "@relay", "no-at-sign", "a b@relay"]) {
      const { status } = await req("POST", "/v1/addresses", {
        address: bad,
        public_key: kp.publicKeySpkiB64,
      });
      assert.equal(status, 400, `expected 400 for ${bad}`);
    }
  });

  it("non-P-256 public key -> 400", async () => {
    const { status } = await req("POST", "/v1/addresses", {
      address: "dave@relay",
      public_key: Buffer.from("not a key").toString("base64"),
    });
    assert.equal(status, 400);
  });

  it("directory lookup (open, no auth)", async () => {
    const { status, json } = await req("GET", "/v1/directory/cara@relay");
    assert.equal(status, 200);
    assert.equal(json.public_key, kp.publicKeySpkiB64);
    assert.ok(!("owner_token" in json));
  });

  it("directory miss -> 404", async () => {
    const { status } = await req("GET", "/v1/directory/nobody@relay");
    assert.equal(status, 404);
  });

  it("rotate pubkey without token -> 401; with token -> 200", async () => {
    const kp2 = generateKeypair();
    const bad = await req("PUT", "/v1/addresses/cara@relay", { public_key: kp2.publicKeySpkiB64 });
    assert.equal(bad.status, 401);
    const ok = await req("PUT", "/v1/addresses/cara@relay", { public_key: kp2.publicKeySpkiB64 }, ownerToken);
    assert.equal(ok.status, 200);
    const dir = await req("GET", "/v1/directory/cara@relay");
    assert.equal(dir.json.public_key, kp2.publicKeySpkiB64);
  });

  it("full flow: send -> inbox fetch -> delete message", async () => {
    const bob = generateKeypair();
    const reg = await req("POST", "/v1/addresses", {
      address: "bob@relay",
      public_key: bob.publicKeySpkiB64,
    });
    const bobToken = reg.json.owner_token;

    const env = encryptEnvelope(bob.publicKeySpkiB64, {
      subject: "ping",
      body: "pong",
      thread_id: "t-1",
    });
    const snd = await req("POST", "/v1/inbox/bob@relay/messages", { from: "cara@relay", ...env });
    assert.equal(snd.status, 201);
    assert.equal(typeof snd.json.id, "number");

    const noAuth = await req("GET", "/v1/inbox/bob@relay/messages");
    assert.equal(noAuth.status, 401);

    const inbox = await req("GET", "/v1/inbox/bob@relay/messages", undefined, bobToken);
    assert.equal(inbox.status, 200);
    assert.equal(inbox.json.messages.length, 1);
    const m = inbox.json.messages[0];
    assert.equal(m.from, "cara@relay");
    assert.equal(m.to, "bob@relay");
    const dec = decryptEnvelope(bob.privateKeyPkcs8B64, m);
    assert.deepEqual(dec, { subject: "ping", body: "pong", thread_id: "t-1" });

    // ?since= filters
    const since = await req("GET", `/v1/inbox/bob@relay/messages?since=${m.id}`, undefined, bobToken);
    assert.equal(since.json.messages.length, 0);

    const del = await req("DELETE", `/v1/inbox/bob@relay/messages/${m.id}`, undefined, bobToken);
    assert.equal(del.status, 200);
    const empty = await req("GET", "/v1/inbox/bob@relay/messages", undefined, bobToken);
    assert.equal(empty.json.messages.length, 0);
  });

  it("send to unknown address -> 404", async () => {
    const kp2 = generateKeypair();
    const env = encryptEnvelope(kp2.publicKeySpkiB64, { subject: "x", body: "y" });
    const { status } = await req("POST", "/v1/inbox/ghost@relay/messages", { from: "cara@relay", ...env });
    assert.equal(status, 404);
  });

  it("delete address without token -> 401; with token -> 200", async () => {
    const kp3 = generateKeypair();
    const reg = await req("POST", "/v1/addresses", { address: "temp@relay", public_key: kp3.publicKeySpkiB64 });
    const bad = await req("DELETE", "/v1/addresses/temp@relay");
    assert.equal(bad.status, 401);
    const ok = await req("DELETE", "/v1/addresses/temp@relay", undefined, reg.json.owner_token);
    assert.equal(ok.status, 200);
    const gone = await req("GET", "/v1/directory/temp@relay");
    assert.equal(gone.status, 404);
  });
});
