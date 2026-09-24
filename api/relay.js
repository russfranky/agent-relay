import { buildApp } from "../src/app.js";

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
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    const reply = await app.handle({
      method: req.method,
      url: req.url,
      headers: req.headers,
      payload: raw || undefined,
      rawRes: res,
    });
    if (reply.hijacked) return; // route owns the socket (live stream)
    sendReply(res, reply);
  } catch (err) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: { code: "internal", message: "internal error" } }));
  }
}
