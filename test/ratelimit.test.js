import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRateLimiter } from "../src/ratelimit.js";
import { createPgRateLimiter } from "../src/ratelimit-pg.js";

/* Fake neon-style sql tag that implements the same upsert semantics as the
   real INSERT ... ON CONFLICT query in ratelimit-pg.js (single-threaded, so
   naturally atomic like one Postgres statement). */
function fakeSql() {
  const rows = new Map(); // key -> { window_start, count, prev_count }
  async function sql(strings, ...values) {
    const text = strings.join("?").trimStart();
    if (text.startsWith('INSERT INTO rate_limits')) {
      const [key, windowStart] = values;
      const windowMs = values[values.length - 1];
      let r = rows.get(key);
      if (!r) {
        r = { window_start: windowStart, count: 1, prev_count: 0 };
      } else {
        const prevCount =
          r.window_start === windowStart ? r.prev_count
          : r.window_start === windowStart - windowMs ? r.count
          : 0;
        const count = r.window_start === windowStart ? r.count + 1 : 1;
        r = { window_start: windowStart, count, prev_count: prevCount };
      }
      rows.set(key, r);
      return [{ count: r.count, prev_count: r.prev_count, window_start: r.window_start }];
    }
    if (text.startsWith('DELETE FROM rate_limits WHERE')) {
      const [cutoff] = values;
      for (const [k, r] of rows) if (r.window_start < cutoff) rows.delete(k);
      return [];
    }
    if (text.startsWith('DELETE FROM rate_limits')) {
      rows.clear();
      return [];
    }
    throw new Error("unexpected query: " + text);
  }
  sql._rows = rows;
  return sql;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("in-memory limiter", () => {
  it("allows up to the limit, then rejects with retry-after", async () => {
    const l = createRateLimiter();
    for (let i = 0; i < 3; i++) {
      assert.deepEqual(await l.hit("k", 3, 60_000), { ok: true, retryAfter: 0 });
    }
    const r = await l.hit("k", 3, 60_000);
    assert.equal(r.ok, false);
    assert.ok(r.retryAfter >= 1 && r.retryAfter <= 60);
  });
  it("tracks keys independently", async () => {
    const l = createRateLimiter();
    await l.hit("a", 1, 60_000);
    assert.equal((await l.hit("a", 1, 60_000)).ok, false);
    assert.equal((await l.hit("b", 1, 60_000)).ok, true);
  });
  it("resets the window after expiry", async () => {
    const l = createRateLimiter();
    await l.hit("k", 1, 50);
    assert.equal((await l.hit("k", 1, 50)).ok, false);
    await sleep(70);
    assert.equal((await l.hit("k", 1, 50)).ok, true);
  });
  it("reset() clears everything", async () => {
    const l = createRateLimiter();
    await l.hit("k", 1, 60_000);
    await l.reset();
    assert.equal((await l.hit("k", 1, 60_000)).ok, true);
  });
});

describe("postgres limiter (fake sql)", () => {
  it("allows up to the limit, then rejects with retry-after", async () => {
    const l = createPgRateLimiter(fakeSql(), { cleanupProbability: 0 });
    for (let i = 0; i < 3; i++) {
      assert.deepEqual(await l.hit("k", 3, 60_000), { ok: true, retryAfter: 0 });
    }
    const r = await l.hit("k", 3, 60_000);
    assert.equal(r.ok, false);
    assert.ok(r.retryAfter >= 1 && r.retryAfter <= 60);
  });
  it("carries the previous window's weight (sliding)", async () => {
    const sql = fakeSql();
    const l = createPgRateLimiter(sql, { cleanupProbability: 0 });
    // Fill the current window to the limit.
    await l.hit("k", 3, 2000);
    await l.hit("k", 3, 2000);
    await l.hit("k", 3, 2000);
    const ws = sql._rows.get("k").window_start;
    // Land ~100ms inside the next window (not two windows out): the previous
    // window still counts almost in full, so the first request is rejected.
    await sleep(Math.max(0, ws + 2000 - Date.now() + 100));
    assert.equal((await l.hit("k", 3, 2000)).ok, false);
    // After the previous window fully ages out, requests are allowed again.
    await sql._rows.clear();
    assert.equal((await l.hit("k", 3, 2000)).ok, true);
  });
  it("forgets windows older than the previous one", async () => {
    const sql = fakeSql();
    const l = createPgRateLimiter(sql, { cleanupProbability: 0 });
    await l.hit("k", 3, 1000);
    await l.hit("k", 3, 1000);
    await l.hit("k", 3, 1000);
    const ws = sql._rows.get("k").window_start;
    // Skip two full windows: prev_count must be 0, not the stale count.
    await sleep(Math.max(0, ws + 2000 - Date.now() + 100));
    for (let i = 0; i < 3; i++) {
      assert.equal((await l.hit("k", 3, 1000)).ok, true);
    }
    assert.equal((await l.hit("k", 3, 1000)).ok, false);
  });
  it("reset() clears everything", async () => {
    const sql = fakeSql();
    const l = createPgRateLimiter(sql, { cleanupProbability: 0 });
    await l.hit("k", 1, 60_000);
    assert.equal(sql._rows.size, 1);
    await l.reset();
    assert.equal(sql._rows.size, 0);
    assert.equal((await l.hit("k", 1, 60_000)).ok, true);
  });
  it("probabilistic cleanup removes stale rows", async () => {
    const sql = fakeSql();
    const l = createPgRateLimiter(sql, { cleanupProbability: 1 });
    await l.hit("old", 1000, 50);
    await sleep(150);
    await l.hit("new", 1000, 50);
    // The stale key's row was cleaned; the live key's row remains.
    assert.ok(!sql._rows.has("old"));
    assert.ok(sql._rows.has("new"));
  });
});
