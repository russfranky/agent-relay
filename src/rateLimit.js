/**
 * In-memory sliding-window limiter. Fine for a single-process prototype.
 */
export function createRateLimiter() {
  const windows = new Map();

  function prune(arr, cutoff) {
    let i = 0;
    while (i < arr.length && arr[i] < cutoff) i++;
    return i ? arr.slice(i) : arr;
  }

  function hit(key, limit, windowMs) {
    if (!limit || limit <= 0) return { ok: true, retryAfter: 0 };
    const now = Date.now();
    const cutoff = now - windowMs;
    const prev = windows.get(key) || [];
    const arr = prune(prev, cutoff);
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
