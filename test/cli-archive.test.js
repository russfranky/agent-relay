import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createApp } from "../src/server.js";

const run = promisify(execFile);

/* Module 2: relay-archive — the CLI persists threads client-side. */

describe("cli --archive", () => {
  let app, server, base, tmp, keyA, keyB, arcDir;

  function cli(args, extraEnv = {}) {
    return run("node", ["bin/relay.js", ...args], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, RELAY_URL: base, ...extraEnv },
    });
  }

  before(async () => {
    app = createApp({ dbPath: ":memory:" });
    server = http.createServer(app.handler);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}`;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-arc-"));
    keyA = path.join(tmp, "a.key.json");
    keyB = path.join(tmp, "b.key.json");
    arcDir = path.join(tmp, "archive");
    await cli(["keygen", "--out", keyA]);
    await cli(["keygen", "--out", keyB]);
    await cli(["register", "--address", "archy", "--key", keyA]);
    await cli(["register", "--address", "sender", "--key", keyB]);
    await cli(["send", "--to", "archy", "--subject", "hello", "--body", "world", "--thread", "t-9", "--from", "sender", "--key", keyB]);
    await cli(["send", "--to", "archy", "--subject", "second", "--body", "msg", "--from", "sender", "--key", keyB]);
  });

  after(async () => {
    await new Promise((r) => server.close(r));
    app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("inbox --archive writes decrypted JSONL per address", async () => {
    const out = await cli(["inbox", "--key", keyA, "--archive", arcDir]);
    assert.match(out.stdout, /archived 2 new message\(s\)/);
    const file = path.join(arcDir, "archy@relay.jsonl");
    assert.ok(fs.existsSync(file));
    const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].subject, "hello");
    assert.equal(lines[0].body, "world");
    assert.equal(lines[0].thread_id, "t-9");
    assert.equal(lines[0].from, "sender@relay");
    assert.equal(lines[0].to, "archy@relay");
    assert.equal(lines[1].subject, "second");
  });

  it("re-running --archive adds no duplicates", async () => {
    const file = path.join(arcDir, "archy@relay.jsonl");
    const before = fs.readFileSync(file, "utf8");
    const out = await cli(["inbox", "--key", keyA, "--archive", arcDir]);
    assert.match(out.stdout, /archived 0 new message\(s\)/);
    assert.equal(fs.readFileSync(file, "utf8"), before);
  });

  it("RELAY_ARCHIVE_DIR env works as fallback", async () => {
    const dir2 = path.join(tmp, "archive2");
    await cli(["inbox", "--key", keyA], { RELAY_ARCHIVE_DIR: dir2 });
    const file = path.join(dir2, "archy@relay.jsonl");
    assert.ok(fs.existsSync(file));
    assert.equal(fs.readFileSync(file, "utf8").trim().split("\n").length, 2);
  });
});
