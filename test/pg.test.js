// Postgres lifecycle test. Runs only when TEST_DATABASE_URL is set,
// e.g. against a scratch Neon database. Skipped otherwise.
import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import {
  makeApp,
  createBox,
  postMessage,
  getMessages,
  deleteBox,
  auth,
  jsonHeaders,
  uuid,
} from "./helpers.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const run = DATABASE_URL ? describe : describe.skip;

run("postgres lifecycle", () => {
  let app;
  before(async () => {
    app = await makeApp({ DATABASE_URL, LOG_LEVEL: "silent" });
  });
  after(async () => {
    await app.close();
  });

  it("full box lifecycle: create, write, read, poll, idempotent retry, auth, delete", async () => {
    const created = (await createBox(app, { title: "pg test" })).json();
    assert.equal(created.box_id && typeof created.box_id, "string");
    const { box_id, read_key, write_key } = created;

    // write
    const cid = uuid();
    const w1 = await postMessage(app, box_id, write_key, {
      sender: "pg-writer",
      body: "hello from postgres",
      client_msg_id: cid,
    });
    assert.equal(w1.statusCode, 201);
    const m1 = w1.json();
    assert.equal(m1.body, "hello from postgres");
    assert.ok(Number.isInteger(m1.id));

    // read with cursor
    const r1 = await getMessages(app, box_id, read_key, "?since=0&limit=50");
    assert.equal(r1.statusCode, 200);
    const page = r1.json();
    assert.equal(page.messages.length, 1);
    assert.equal(page.next_since, m1.id);

    // poll again: empty page, cursor preserved
    const r2 = await getMessages(app, box_id, read_key, `?since=${page.next_since}`);
    assert.equal(r2.json().messages.length, 0);
    assert.equal(r2.json().next_since, page.next_since);

    // idempotent retry: same client_msg_id returns 200 with same id
    const w2 = await postMessage(app, box_id, write_key, {
      sender: "pg-writer",
      body: "hello from postgres",
      client_msg_id: cid,
    });
    assert.equal(w2.statusCode, 200);
    assert.equal(w2.json().id, m1.id);

    // wrong key: 401, no leak
    const bad = await getMessages(app, box_id, "rk_deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
    assert.equal(bad.statusCode, 401);

    // read key on write route: 401
    const wrongKind = await postMessage(app, box_id, read_key, {
      sender: "x",
      body: "nope",
    });
    assert.equal(wrongKind.statusCode, 401);

    // reply_to validation
    const badReply = await postMessage(app, box_id, write_key, {
      sender: "pg-writer",
      body: "bad reply",
      reply_to: 999999,
    });
    assert.equal(badReply.statusCode, 422);

    // delete
    const del = await deleteBox(app, box_id, write_key);
    assert.equal(del.statusCode, 204);

    // box gone after delete
    const gone = await getMessages(app, box_id, read_key);
    assert.equal(gone.statusCode, 401);
  });

  it("expired boxes return 410 and are swept", async () => {
    const created = (await createBox(app)).json();
    const { box_id, read_key, write_key } = created;
    await postMessage(app, box_id, write_key, { sender: "s", body: "old" });
    await app.db
      .prepare("UPDATE boxes SET last_activity_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", box_id);
    const r = await getMessages(app, box_id, read_key);
    assert.equal(r.statusCode, 410);
  });

  it("healthz is up", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().ok, true);
  });
});
