// Vercel serverless entrypoint for Agent Relay.
// Uses Postgres (Neon) via DATABASE_URL because the serverless filesystem
// is ephemeral and mailboxes must persist.
import { createApp } from "../src/server.js";
import { openPgDb } from "../src/db-pg.js";

let appPromise = null;

function getApp() {
  if (!appPromise) {
    appPromise = (async () => {
      const store = await openPgDb(process.env.DATABASE_URL);
      return createApp({ db: store });
    })();
  }
  return appPromise;
}

export default async function handler(req, res) {
  try {
    const app = await getApp();
    return app.handler(req, res);
  } catch (e) {
    console.error("relay init error:", e);
    res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: { code: "internal", message: "relay unavailable" } }));
  }
}
