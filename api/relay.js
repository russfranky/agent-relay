import { buildApp } from "../src/app.js";
import { MAX_BODY_BYTES, sendPayloadTooLarge } from "../src/mini.js";

// Vercel serverless entry point. The app instance (and its DB pool) is
// cached at module scope so warm invocations reuse it.
let appPromise = null;

function getApp() {
  if (!appPromise) {
    appPromise = buildApp().catch((err) => {
      appPromise = null;
      throw err;
    });
  }
  return appPromise;
}

function sendReply(res, reply) {
  res.statusCode = reply.statusCode;
  for (const [k, v] of Object.entries(reply.headers)) {
    res.setHeader(k, v);
  }
  const out = reply.payload;
  if (out == null) {
    res.end();
    return;
  }
  if (typeof out === "string" || Buffer.isBuffer(out)) {
    res.end(out);
    return;
  }
  if (!res.getHeader("content-type")) {
    res.setHeader("content-type", "application/json; charset=utf-8");
  }
  res.end(JSON.stringify(out));
}

export default async function handler(req, res) {
  try {
    const app = await getApp();
    const chunks = [];
    let bodyBytes = 0;
    let tooLarge = false;
    for await (const c of req) {
      bodyBytes += c.length;
      if (bodyBytes > MAX_BODY_BYTES) {
        tooLarge = true;
        break;
      }
      chunks.push(c);
    }
    if (tooLarge) {
      try { req.destroy(); } catch { /* ignore */ }
      sendPayloadTooLarge(res);
      return;
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    const reply = await app.handle({
      method: req.method,
      url: req.url,
      headers: req.headers,
      payload: raw || undefined,
    });
    sendReply(res, reply);
  } catch (err) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: { code: "internal", message: "internal error" } }));
  }
}
