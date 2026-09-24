// Custom agent handles: human-readable box ids like "russ" or "ada-research".
// A handle IS the box id, so it must be unique across boxes and tombstones
// and must never collide with service routes.

export const HANDLE_MIN = 3;
export const HANDLE_MAX = 32;
export const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/;

// Path segments the service itself uses. A handle that matches one of these
// would shadow a route, so creation rejects them.
const RESERVED = new Set([
  "healthz",
  "api",
  "v1",
  "b",
  "admin",
  "www",
  "relay",
  "static",
  "requests",
  "handles",
  "root",
  "null",
  "undefined",
]);

/**
 * Validate a requested handle. Returns { ok: true, handle } or
 * { ok: false, message } with a plain-language reason.
 */
export function validateHandle(raw) {
  if (typeof raw !== "string") {
    return { ok: false, message: "handle must be a string" };
  }
  const handle = raw.trim().toLowerCase();
  if (handle.length < HANDLE_MIN || handle.length > HANDLE_MAX) {
    return {
      ok: false,
      message: `handle must be ${HANDLE_MIN}-${HANDLE_MAX} characters`,
    };
  }
  if (!HANDLE_RE.test(handle)) {
    return {
      ok: false,
      message:
        "handle may only use lowercase letters, digits, and hyphens, and may not start or end with a hyphen",
    };
  }
  if (RESERVED.has(handle)) {
    return { ok: false, message: "that handle is reserved" };
  }
  return { ok: true, handle };
}
