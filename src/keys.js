import { createHash, randomBytes } from "node:crypto";

export function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function generateKey(prefix) {
  const raw = randomBytes(32).toString("base64url");
  return `${prefix}${raw}`;
}

export function generateKeyPair() {
  return {
    readKey: generateKey("rk_"),
    writeKey: generateKey("wk_"),
  };
}

export function hashKey(key) {
  return sha256Hex(key);
}

export function isReadKey(key) {
  return typeof key === "string" && key.startsWith("rk_");
}

export function isWriteKey(key) {
  return typeof key === "string" && key.startsWith("wk_");
}

// Guest grant: a share-link token. Reads and writes chat messages on one
// box, but cannot delete the box, or rotate grants.
export function generateGrant() {
  return generateKey("gt_");
}

export function isGrantKey(key) {
  return typeof key === "string" && key.startsWith("gt_");
}
