import { createApp } from "./mini.js";
import { loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { openPg } from "./db-pg.js";
import { createRateLimiter } from "./rateLimit.js";
import { startSweeper } from "./sweeper.js";
import { ApiError, errorPayload, errors } from "./errors.js";
import healthRoutes from "./routes/health.js";
import boxRoutes from "./routes/boxes.js";
import messageRoutes from "./routes/messages.js";
import requestRoutes from "./routes/requests.js";
import streamRoutes from "./routes/stream.js";
import webRoutes from "./routes/web.js";

export async function buildApp(overrides = {}) {
  const config = loadConfig(overrides);
  // Postgres when DATABASE_URL is set (e.g. Vercel), otherwise local SQLite.
  const db = config.databaseUrl
    ? openPg(config.databaseUrl)
    : openDb(config.dbPath);
  if (db.migrate) await db.migrate();
  const limiter = createRateLimiter();
  const app = createApp();

  app.decorate("config", config);
  app.decorate("db", db);
  app.decorate("limiter", limiter);
  app.log = { info() {}, error() {}, warn() {}, debug() {} };

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      if (err.extra.retryAfter) reply.header("Retry-After", String(err.extra.retryAfter));
      return reply.code(err.status).send(errorPayload(err));
    }
    if (err.statusCode === 413 || err.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return reply.code(413).send(errorPayload(errors.payloadTooLarge()));
    }
    return reply.code(500).send(errorPayload(errors.internal()));
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send(errorPayload(errors.notFound()));
  });

  await app.register(healthRoutes);
  await app.register(boxRoutes);
  await app.register(messageRoutes);
  await app.register(requestRoutes);
  await app.register(streamRoutes);
  await app.register(webRoutes);

  const stopSweep = startSweeper(db, config, app.log);
  app.addHook("onClose", async () => {
    stopSweep();
    await db.close();
  });

  return app;
}
