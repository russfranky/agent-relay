export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const errors = {
  unauthorized: (msg = "unauthorized") => new ApiError(401, "unauthorized", msg),
  notFound: (msg = "not found") => new ApiError(404, "not_found", msg),
  validation: (msg) => new ApiError(422, "validation_failed", msg),
  rateLimited: (retryAfter) =>
    new ApiError(429, "rate_limited", "too many requests", { retryAfter }),
  payloadTooLarge: (msg = "payload too large") =>
    new ApiError(413, "payload_too_large", msg),
  boxFull: () =>
    new ApiError(
      409,
      "box_full",
      "box has reached MAX_BOX_MESSAGES; delete the box or wait for retention expiry"
    ),
  goneExpired: () => new ApiError(410, "gone_expired", "box has expired"),
  internal: (msg = "internal error") => new ApiError(500, "internal", msg),
};

export function errorPayload(err) {
  return {
    error: {
      code: err.code || "internal",
      message: err.message || "internal error",
    },
  };
}
