import crypto from "node:crypto";

// E2E envelope crypto. No handrolled primitives:
//   ephemeral ECDH P-256 -> HKDF-SHA256 -> AES-256-GCM
// Public keys are SPKI DER (base64 on the wire); private keys PKCS8 DER (base64).
// Ephemeral-static ECDH gives forward secrecy per message.
export const HKDF_INFO = "relay-v3-envelope";

export function generateKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  return {
    publicKeySpkiB64: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    privateKeyPkcs8B64: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  };
}

export function parseSpkiPublicKey(b64) {
  let der;
  try {
    der = Buffer.from(String(b64), "base64");
  } catch {
    throw new Error("public key is not valid base64");
  }
  if (der.length === 0) throw new Error("public key is empty");
  let key;
  try {
    key = crypto.createPublicKey({ key: der, format: "der", type: "spki" });
  } catch {
    throw new Error("public key is not a valid SPKI key");
  }
  const details = key.asymmetricKeyDetails;
  if (!details || details.namedCurve !== "prime256v1") {
    throw new Error("public key is not P-256");
  }
  return key;
}

export function parsePkcs8PrivateKey(b64) {
  const der = Buffer.from(String(b64), "base64");
  return crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

function deriveAesKey(sharedSecret) {
  return Buffer.from(crypto.hkdfSync("sha256", sharedSecret, Buffer.alloc(0), HKDF_INFO, 32));
}

// payload: { subject, body, thread_id? } -> { ephemeral_pubkey, nonce, ciphertext } (all base64)
export function encryptEnvelope(recipientSpkiB64, payload) {
  const { subject, body, thread_id } = payload ?? {};
  if (typeof subject !== "string" || typeof body !== "string") {
    throw new Error("subject and body must be strings");
  }
  const recipientKey = parseSpkiPublicKey(recipientSpkiB64);
  const ephemeral = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const secret = crypto.diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipientKey });
  const aesKey = deriveAesKey(secret);
  const nonce = crypto.randomBytes(12);
  const plaintext = JSON.stringify({ subject, body, thread_id: thread_id ?? null });
  const cipher = crypto.createCipheriv("aes-256-gcm", aesKey, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return {
    ephemeral_pubkey: ephemeral.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

// envelope: { ephemeral_pubkey, nonce, ciphertext } -> { subject, body, thread_id }
export function decryptEnvelope(privateKeyPkcs8B64, envelope) {
  const { ephemeral_pubkey, nonce, ciphertext } = envelope ?? {};
  const priv = parsePkcs8PrivateKey(privateKeyPkcs8B64);
  const ephPub = parseSpkiPublicKey(ephemeral_pubkey);
  const secret = crypto.diffieHellman({ privateKey: priv, publicKey: ephPub });
  const aesKey = deriveAesKey(secret);
  const nonceBuf = Buffer.from(String(nonce), "base64");
  const ctBuf = Buffer.from(String(ciphertext), "base64");
  if (nonceBuf.length !== 12) throw new Error("bad nonce length");
  if (ctBuf.length < 17) throw new Error("ciphertext too short");
  const tag = ctBuf.subarray(ctBuf.length - 16);
  const data = ctBuf.subarray(0, ctBuf.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey, nonceBuf);
  decipher.setAuthTag(tag);
  let plaintext;
  try {
    plaintext = Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("decryption failed (wrong key or tampered envelope)");
  }
  let obj;
  try {
    obj = JSON.parse(plaintext);
  } catch {
    throw new Error("envelope payload is not valid JSON");
  }
  if (typeof obj.subject !== "string" || typeof obj.body !== "string") {
    throw new Error("envelope payload is malformed");
  }
  return { subject: obj.subject, body: obj.body, thread_id: obj.thread_id ?? null };
}
