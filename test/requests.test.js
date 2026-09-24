import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withApp, createBox, auth, errOf, jsonHeaders } from "./helpers.js";

async function createRequest(app, boxId, body) {
  return app.inject({
    method: "POST",
    url: `/v1/boxes/${boxId}/requests`,
    headers: jsonHeaders(),
    payload: body,
  });
}

describe("connection requests", { concurrency: false }, () => {
  it("creates a pending request without a key", async () => {
    await withApp({}, async (app) => {
      const box = (await createBox(app, { handle: "req-target" })).json();
      const res = await createRequest(app, "req-target", {
        from_handle: "ada-bot",
        from_name: "Ada",
        note: "want to trade notes",
      });
      assert.equal(res.statusCode, 201);
      const body = res.json();
      assert.equal(body.box_id, "req-target");
      assert.equal(body.from_handle, "ada-bot");
      assert.equal(body.from_name, "Ada");
      assert.equal(body.note, "want to trade notes");
      assert.equal(body.status, "pending");
      assert.equal(body.decided_at, null);
      assert.ok(box.read_key);
    });
  });

  it("missing box answers 401 and bad input answers 422", async () => {
    await withApp({}, async (app) => {
      const missing = await createRequest(app, "no-such-box-99", { from_handle: "x" });
      assert.equal(missing.statusCode, 401);

      const box = (await createBox(app, {})).json();
      const noHandle = await createRequest(app, box.box_id, { note: "hi" });
      assert.equal(noHandle.statusCode, 422);
      assert.equal(errOf(noHandle).code, "validation_failed");

      const longNote = await createRequest(app, box.box_id, {
        from_handle: "x",
        note: "n".repeat(501),
      });
      assert.equal(longNote.statusCode, 422);
    });
  });

  it("lists pending requests with the read key", async () => {
    await withApp({}, async (app) => {
      const box = (await createBox(app, {})).json();
      await createRequest(app, box.box_id, { from_handle: "bot-one" });
      await createRequest(app, box.box_id, { from_handle: "bot-two" });

      const listed = await app.inject({
        method: "GET",
        url: `/v1/boxes/${box.box_id}/requests`,
        headers: auth(box.read_key),
      });
      assert.equal(listed.statusCode, 200);
      const body = listed.json();
      assert.equal(body.requests.length, 2);
      assert.ok(body.requests.every((r) => r.status === "pending"));

      const denied = await app.inject({
        method: "GET",
        url: `/v1/boxes/${box.box_id}/requests`,
        headers: auth("rk_bogus"),
      });
      assert.equal(denied.statusCode, 401);
    });
  });

  it("approve and reject need the write key and are idempotent", async () => {
    await withApp({}, async (app) => {
      const box = (await createBox(app, {})).json();
      const created = (await createRequest(app, box.box_id, { from_handle: "bot-a" })).json();

      const readKeyTry = await app.inject({
        method: "POST",
        url: `/v1/boxes/${box.box_id}/requests/${created.id}/approve`,
        headers: auth(box.read_key),
      });
      assert.equal(readKeyTry.statusCode, 401);

      const approved = await app.inject({
        method: "POST",
        url: `/v1/boxes/${box.box_id}/requests/${created.id}/approve`,
        headers: auth(box.write_key),
      });
      assert.equal(approved.statusCode, 200);
      assert.equal(approved.json().status, "approved");
      assert.ok(approved.json().decided_at);

      const again = await app.inject({
        method: "POST",
        url: `/v1/boxes/${box.box_id}/requests/${created.id}/approve`,
        headers: auth(box.write_key),
      });
      assert.equal(again.statusCode, 200);
      assert.equal(again.json().status, "approved");

      const second = (await createRequest(app, box.box_id, { from_handle: "bot-b" })).json();
      const rejected = await app.inject({
        method: "POST",
        url: `/v1/boxes/${box.box_id}/requests/${second.id}/reject`,
        headers: auth(box.write_key),
      });
      assert.equal(rejected.statusCode, 200);
      assert.equal(rejected.json().status, "rejected");

      // pending list is now empty; all shows history
      const pending = (
        await app.inject({
          method: "GET",
          url: `/v1/boxes/${box.box_id}/requests`,
          headers: auth(box.read_key),
        })
      ).json();
      assert.equal(pending.requests.length, 0);
      const all = (
        await app.inject({
          method: "GET",
          url: `/v1/boxes/${box.box_id}/requests?status=all`,
          headers: auth(box.read_key),
        })
      ).json();
      assert.equal(all.requests.length, 2);

      const missing = await app.inject({
        method: "POST",
        url: `/v1/boxes/${box.box_id}/requests/99999/approve`,
        headers: auth(box.write_key),
      });
      assert.equal(missing.statusCode, 404);
    });
  });

  it("deleting the box removes its requests", async () => {
    await withApp({}, async (app) => {
      const box = (await createBox(app, {})).json();
      await createRequest(app, box.box_id, { from_handle: "bot-z" });
      const del = await app.inject({
        method: "DELETE",
        url: `/v1/boxes/${box.box_id}`,
        headers: auth(box.write_key),
      });
      assert.equal(del.statusCode, 204);
      const count = await app.db
        .prepare("SELECT COUNT(*) AS n FROM connection_requests WHERE box_id = ?")
        .get(box.box_id);
      assert.equal(count.n, 0);
    });
  });

  it("web snapshot includes pending requests and the box page lists them", async () => {
    await withApp({}, async (app) => {
      const box = (await createBox(app, { handle: "web-req-box" })).json();
      await createRequest(app, "web-req-box", { from_handle: "web-bot", note: "hello owner" });

      const snap = await app.inject({
        method: "GET",
        url: "/b/web-req-box/snapshot",
        headers: auth(box.read_key),
      });
      assert.equal(snap.statusCode, 200);
      const snapBody = snap.json();
      assert.equal(snapBody.requests.length, 1);
      assert.equal(snapBody.requests[0].from_handle, "web-bot");

      const unlocked = await app.inject({
        method: "POST",
        url: "/b/web-req-box",
        headers: { "content-type": "application/json" },
        payload: { action: "unlock", read_key: box.read_key },
      });
      assert.equal(unlocked.statusCode, 200);
      assert.ok(unlocked.body.includes('data-testid="requests"'));
      assert.ok(unlocked.body.includes("web-bot"));
      assert.ok(unlocked.body.includes("hello owner"));

      // approve through the web form action
      const reqId = snapBody.requests[0].id;
      const decided = await app.inject({
        method: "POST",
        url: "/b/web-req-box",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: `action=approve_request&req_id=${reqId}&read_key=${encodeURIComponent(
          box.read_key
        )}&write_key=${encodeURIComponent(box.write_key)}`,
      });
      assert.equal(decided.statusCode, 200);
      assert.ok(decided.body.includes('data-testid="no-requests"'));

      const after = (
        await app.inject({
          method: "GET",
          url: "/b/web-req-box/snapshot",
          headers: auth(box.read_key),
        })
      ).json();
      assert.equal(after.requests.length, 0);
    });
  });
});
