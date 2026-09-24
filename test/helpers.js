import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app.js";

export async function makeApp(overrides = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "agent-relay-"));
  const app = await buildApp({
    DB_PATH: path.join(dir, "test.db"),
    LOG_LEVEL: "silent",
    SWEEP_INTERVAL_MS: 24 * 60 * 60 * 1000,
    ...overrides,
  });
  await app.ready();
  return app;
}

export async function withApp(overrides, fn) {
  const app = await makeApp(overrides);
  try {
    return await fn(app);
  } finally {
    await app.close();
  }
}

export function jsonHeaders(extra = {}) {
  return { "content-type": "application/json", ...extra };
}

export function auth(key, extra = {}) {
  return jsonHeaders({ authorization: `Bearer ${key}`, ...extra });
}

export async function createBox(app, body = {}) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/boxes",
    headers: jsonHeaders(),
    payload: body,
  });
  return res;
}

export async function postMessage(app, boxId, writeKey, payload) {
  return app.inject({
    method: "POST",
    url: `/v1/boxes/${boxId}/messages`,
    headers: auth(writeKey),
    payload,
  });
}

export async function getMessages(app, boxId, readKey, query = "") {
  return app.inject({
    method: "GET",
    url: `/v1/boxes/${boxId}/messages${query}`,
    headers: auth(readKey),
  });
}

export async function deleteBox(app, boxId, writeKey) {
  return app.inject({
    method: "DELETE",
    url: `/v1/boxes/${boxId}`,
    headers: auth(writeKey),
  });
}

export function errOf(res) {
  const body = res.json();
  return body && body.error ? body.error : body;
}

export function uuid() {
  return randomUUID();
}
