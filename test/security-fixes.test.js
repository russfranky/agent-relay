// Regression tests for the 2026-09-24 security audit fixes:
// pg type normalization, request body cap, route-param decoding,
// per-IP rate limiting on the web create form.
import { describe, it, after } from "node:test";
import assert from "node:assert";
import { normalizeRow } from "../src/db-pg.js";
import { MAX_BODY_BYTES } from "../src/mini.js";
import { makeApp, jsonHeaders } from "./helpers.js";

describe("pg normalizeRow keeps TEXT columns as strings", () => {
  it("does not corrupt digit-only body, sender, or title", () => {
    const row = normalizeRow({
      id: "42",
      box_id: "olive-portal-63",
      client_msg_id: "9f3c2a1b-0000-4000-8000-000000000000",
      sender: "007",
      recipient: "12345",
      reply_to: "7",
      body: "07700900123",
      title: "2024",
      created_at: new Date("2026-09-24T00:00:00.000Z"),
      retention_days: "30",
      n: "3",
    });
    // TEXT columns stay strings, even when all digits.
    assert.strictEqual(row.body, "07700900123");
    assert.strictEqual(row.sender, "007");
    assert.strictEqual(row.recipient, "12345");
    assert.strictEqual(row.title, "2024");
    assert.strictEqual(row.box_id, "olive-portal-63");
    assert.strictEqual(row.client_msg_id, "9f3c2a1b-0000-4000-8000-000000000000");
    // BIGINT / INTEGER / count columns become numbers.
    assert.strictEqual(row.id, 42);
    assert.strictEqual(row.reply_to, 7);
    assert.strictEqual(row.retention_days, 30);
    assert.strictEqual(row.n, 3);
    // TIMESTAMPTZ becomes an ISO string.
    assert.strictEqual(row.created_at, "2026-09-24T00:00:00.000Z");
  });

  it("keeps long digit strings exact (no precision loss)", () => {
    const row = normalizeRow({ body: "9007199254740993" });
    assert.strictEqual(row.body, "9007199254740993");
  });
});

describe("request body size cap", () => {
  let app;
  after(async () => {
    if (app) await app.close();
  });

  it("rejects bodies over 1MB with 413", async () => {
    app = await makeApp();
    const server = await app.listen({ port: 0, host: "127.0.0.1" });
    const port = server.address().port;
    const big = "x".repeat(MAX_BODY_BYTES + 1024);
    const res = await fetch(`http://127.0.0.1:${port}/v1/boxes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: big }),
    });
    assert.strictEqual(res.status, 413);
    assert.strictEqual((await res.json()).error.code, "payload_too_large");
    // A normal request still works after the rejected one.
    const ok = await fetch(`http://127.0.0.1:${port}/v1/boxes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.strictEqual(ok.status, 201);
  });
});

describe("malformed route params", () => {
  it("returns 404, not 500, for invalid percent-encoding", async () => {
    const app = await makeApp();
    try {
      const res = await app.inject({ method: "GET", url: "/c/%E0%A4%A" });
      assert.strictEqual(res.statusCode, 404);
    } finally {
      await app.close();
    }
  });
});

describe("web create form rate limit is per client IP", () => {
  it("different IPs get separate create buckets", async () => {
    const app = await makeApp({ RATE_LIMIT_CREATE_PER_IP_PER_DAY: 3 });
    try {
      const form = (ip) =>
        app.inject({
          method: "POST",
          url: "/",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "x-forwarded-for": ip,
          },
          payload: "action=claim&title=audit",
        });
      // IP .11 exhausts its 3/day budget: the form re-renders with an
      // error banner instead of creating more chats...
      for (let i = 0; i < 3; i++) {
        const r = await form("10.0.0.11");
        assert.strictEqual(r.statusCode, 200);
        assert.ok(!r.payload.includes('data-testid="error"'));
      }
      const limited = await form("10.0.0.11");
      assert.strictEqual(limited.statusCode, 200);
      assert.ok(limited.payload.includes("too many requests"));
      // ...while a different IP is unaffected.
      const other = await form("10.0.0.22");
      assert.strictEqual(other.statusCode, 200);
      assert.ok(!other.payload.includes('data-testid="error"'));
    } finally {
      await app.close();
    }
  });
});
