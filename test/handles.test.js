import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withApp, createBox, auth, errOf } from "./helpers.js";

describe("custom handles", { concurrency: false }, () => {
  it("creates a box with the requested handle", async () => {
    await withApp({}, async (app) => {
      const res = await createBox(app, { handle: "russ", title: "Russ drop box" });
      assert.equal(res.statusCode, 201);
      const body = res.json();
      assert.equal(body.box_id, "russ");
      assert.equal(body.handle, "russ");
      assert.match(body.read_key, /^rk_/);
      assert.match(body.write_key, /^wk_/);
    });
  });

  it("normalizes handles to lowercase", async () => {
    await withApp({}, async (app) => {
      const res = await createBox(app, { handle: "Ada-Bot" });
      assert.equal(res.statusCode, 201);
      assert.equal(res.json().box_id, "ada-bot");
    });
  });

  it("rejects invalid handles with 422", async () => {
    await withApp({}, async (app) => {
      for (const bad of ["ab", "-lead", "trail-", "UP", "has space", "a".repeat(33), "healthz", "v1", "b"]) {
        const res = await createBox(app, { handle: bad });
        assert.equal(res.statusCode, 422, `expected 422 for ${JSON.stringify(bad)}`);
        assert.equal(errOf(res).code, "validation_failed");
      }
    });
  });

  it("rejects a taken handle with 409, including tombstones", async () => {
    await withApp({}, async (app) => {
      const first = await createBox(app, { handle: "taken-handle" });
      assert.equal(first.statusCode, 201);
      const dup = await createBox(app, { handle: "taken-handle" });
      assert.equal(dup.statusCode, 409);
      assert.equal(errOf(dup).code, "conflict");

      // delete it, then the tombstone still blocks re-claim
      const created = first.json();
      const del = await app.inject({
        method: "DELETE",
        url: `/v1/boxes/${created.box_id}`,
        headers: auth(created.write_key),
      });
      assert.equal(del.statusCode, 204);
      const again = await createBox(app, { handle: "taken-handle" });
      assert.equal(again.statusCode, 409);
    });
  });

  it("random boxes still work and report handle null", async () => {
    await withApp({}, async (app) => {
      const res = await createBox(app, { title: "random" });
      assert.equal(res.statusCode, 201);
      const body = res.json();
      assert.match(body.box_id, /^[a-z]+-[a-z]+-\d+$/);
      assert.equal(body.handle, null);
    });
  });

  it("a handle box works end to end over the API", async () => {
    await withApp({}, async (app) => {
      const created = (await createBox(app, { handle: "e2e-handle" })).json();
      const posted = await app.inject({
        method: "POST",
        url: "/v1/boxes/e2e-handle/messages",
        headers: auth(created.write_key),
        payload: {
          sender: "buddy",
          body: "hello russ",
          client_msg_id: "550e8400-e29b-41d4-a716-446655440000",
        },
      });
      assert.equal(posted.statusCode, 201);
      const read = await app.inject({
        method: "GET",
        url: "/v1/boxes/e2e-handle/messages?since=0&limit=50",
        headers: auth(created.read_key),
      });
      assert.equal(read.statusCode, 200);
      assert.equal(read.json().messages[0].body, "hello russ");
    });
  });
});

describe("landing page", { concurrency: false }, () => {
  it("GET / renders the chat link form", async () => {
    await withApp({}, async (app) => {
      const res = await app.inject({ method: "GET", url: "/" });
      assert.equal(res.statusCode, 200);
      assert.match(res.headers["content-type"], /text\/html/);
      assert.match(res.body, /make your chat link/i);
      assert.ok(res.body.includes('data-testid="claim-form"'));
    });
  });

  it("POST / creates a chat and shows the share link once", async () => {
    await withApp({}, async (app) => {
      const res = await app.inject({
        method: "POST",
        url: "/",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: "action=claim&handle=webhandle1&title=Web+Box",
      });
      assert.equal(res.statusCode, 200);
      assert.ok(res.body.includes('data-testid="read-key"'));
      assert.ok(res.body.includes('data-testid="write-key"'));
      assert.ok(res.body.includes('data-testid="share-url"'));
      assert.match(res.body, /\/c\/webhandle1#g=gt_/);
      assert.ok(res.body.includes('data-testid="agent-snippet"'));
    });
  });

  it("POST / without a handle generates a random link name", async () => {
    await withApp({}, async (app) => {
      const res = await app.inject({
        method: "POST",
        url: "/",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: "action=claim&title=No+Handle+Box",
      });
      assert.equal(res.statusCode, 200);
      assert.ok(res.body.includes('data-testid="share-url"'));
      assert.match(res.body, /\/c\/[a-z]+-[a-z]+-\d+#g=gt_/);
    });
  });

  it("POST / with a taken handle shows an error", async () => {
    await withApp({}, async (app) => {
      await createBox(app, { handle: "duphandle" });
      const res = await app.inject({
        method: "POST",
        url: "/",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: "action=claim&handle=duphandle",
      });
      assert.equal(res.statusCode, 200);
      assert.ok(res.body.includes('data-testid="error"'));
      assert.match(res.body, /already taken/i);
    });
  });
});
