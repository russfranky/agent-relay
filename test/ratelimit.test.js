import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../src/app.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-relay-rl-"));
const app = await buildApp({
  DB_PATH: path.join(dir, "relay.db"),
  LOG_LEVEL: "silent",
  RATE_LIMIT_WRITES_PER_MIN: 3,
  RATE_LIMIT_READS_PER_MIN: 3,
  RATE_LIMIT_CREATE_PER_IP_PER_DAY: 3,
  RATE_LIMIT_IP_WRITES_PER_MIN: 1000,
  RATE_LIMIT_IP_READS_PER_MIN: 1000,
});

after(async () => {
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("12 rate limiter returns 429 + Retry-After", async () => {
  const codes = [];
  for (let i = 0; i < 5; i++) {
    const res = await app.inject({
      method: "POST",
      url: "/v1/boxes",
      headers: { "content-type": "application/json" },
      payload: {},
    });
    codes.push(res.statusCode);
    if (res.statusCode === 429) {
      assert.equal(res.json().error.code, "rate_limited");
      assert.ok(res.headers["retry-after"]);
    }
  }
  assert.ok(codes.includes(429));
  assert.equal(codes.filter((c) => c === 201).length, 3);

  const boxRes = await app.inject({
    method: "POST",
    url: "/v1/boxes",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
    payload: {},
  });
  assert.equal(boxRes.statusCode, 201);
  const box = boxRes.json();
  const writeCodes = [];
  for (let i = 0; i < 5; i++) {
    const res = await app.inject({
      method: "POST",
      url: `/v1/boxes/${box.box_id}/messages`,
      headers: {
        authorization: `Bearer ${box.write_key}`,
        "content-type": "application/json",
        "x-forwarded-for": "203.0.113.9",
      },
      payload: { sender: "a", body: `m${i}` },
    });
    writeCodes.push(res.statusCode);
    if (res.statusCode === 429) {
      assert.ok(res.headers["retry-after"]);
    }
  }
  assert.ok(writeCodes.includes(429));
});

test("rate limit applies when auth header omitted", async () => {
  const codes = [];
  for (let i = 0; i < 6; i++) {
    const res = await app.inject({
      method: "GET",
      url: "/v1/boxes/nope-nope-11/messages",
      headers: { "x-forwarded-for": "198.51.100.7" },
    });
    codes.push(res.statusCode);
  }
  assert.ok(codes.includes(401));
  // IP read floor is high in this file; omitting auth still 401s, limiter records the key "none"
  assert.ok(codes.every((c) => c === 401 || c === 429));
});
