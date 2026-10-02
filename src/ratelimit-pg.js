// Postgres-backed sliding-window rate limiter. One atomic upsert per hit, so
// every serverless instance enforces the same counters (the in-memory limiter
// in ratelimit.js cannot do this: each Vercel function instance gets its own
// copy). Same { ok, retryAfter } shape as the memory limiter.
//
// Sliding-window approximation: each key stores the current fixed window's
// count plus the previous window's count; the estimate weights the previous
// window by how much of it still overlaps the trailing windowMs.
export function createPgRateLimiter(sql, { cleanupProbability = 0.02 } = {}) {
  async function hit(key, limit, windowMs) {
    if (!limit || limit <= 0) return { ok: true, retryAfter: 0 };
    const now = Date.now();
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const rows = await sql`
      INSERT INTO rate_limits ("key", window_start, count, prev_count)
      VALUES (${key}, ${windowStart}, 1, 0)
      ON CONFLICT ("key") DO UPDATE SET
        prev_count = CASE
          WHEN rate_limits.window_start = EXCLUDED.window_start THEN rate_limits.prev_count
          WHEN rate_limits.window_start = EXCLUDED.window_start - ${windowMs} THEN rate_limits.count
          ELSE 0
        END,
        count = CASE
          WHEN rate_limits.window_start = EXCLUDED.window_start THEN rate_limits.count + 1
          ELSE 1
        END,
        window_start = EXCLUDED.window_start
      RETURNING count, prev_count, window_start`;
    const row = rows[0];
    const count = Number(row.count);
    const prevCount = Number(row.prev_count);
    const ws = Number(row.window_start);
    const elapsed = now - ws;
    const estimate = count + prevCount * ((windowMs - elapsed) / windowMs);
    if (estimate > limit) {
      const retryAfter = Math.max(1, Math.ceil((ws + windowMs - now) / 1000));
      return { ok: false, retryAfter };
    }
    // Opportunistic cleanup so stale rows don't accumulate forever.
    if (Math.random() < cleanupProbability) {
      sql`DELETE FROM rate_limits WHERE window_start < ${windowStart - windowMs}`.catch(() => {});
    }
    return { ok: true, retryAfter: 0 };
  }

  return {
    hit,
    async reset() {
      await sql`DELETE FROM rate_limits`;
    },
  };
}
