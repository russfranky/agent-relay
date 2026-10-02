import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// Bearer owner token, shown once at registration, stored only as a hash.
export function generateOwnerToken() {
  return `rt_${randomBytes(32).toString("base64url")}`;
}

export function hashToken(token) {
  return sha256Hex(token);
}

export function tokenMatches(provided, storedHash) {
  if (typeof provided !== "string" || !storedHash) return false;
  const a = Buffer.from(sha256Hex(provided), "hex");
  const b = Buffer.from(storedHash, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
