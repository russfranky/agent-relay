// In-memory sliding-window rate limiter. Single-process; fine for this service.
export function createRateLimiter() {
  const windows = new Map();

  function hit(key, limit, windowMs) {
    if (!limit || limit <= 0) return { ok: true, retryAfter: 0 };
    const now = Date.now();
    const cutoff = now - windowMs;
    let arr = windows.get(key) || [];
    arr = arr.filter((t) => t >= cutoff);
    if (arr.length >= limit) {
      windows.set(key, arr);
      const retryAfter = Math.max(1, Math.ceil((arr[0] + windowMs - now) / 1000));
      return { ok: false, retryAfter };
    }
    arr.push(now);
    windows.set(key, arr);
    return { ok: true, retryAfter: 0 };
  }

  return {
    hit,
    reset() {
      windows.clear();
    },
  };
}
