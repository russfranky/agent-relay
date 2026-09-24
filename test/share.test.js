// Share-link grants (gt_), invite rotation, wait long-poll,
// and the human chat web pages.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withApp, createBox, postMessage, auth } from "./helpers.js";
import { isGrantKey } from "../src/keys.js";

function grantFromShareUrl(shareUrl) {
  const m = String(shareUrl).match(/#g=(gt_[^&]+)/);
  assert.ok(m, `share_url missing #g= grant: ${shareUrl}`);
  return m[1];
}

describe("share-link grants", { concurrency: false }, () => {
  it("create returns a share_url with a gt_ grant", async () => {
    await withApp({}, async (app) => {
      const box = (await createBox(app, {})).json();
      assert.ok(box.share_url);
      assert.match(box.share_url, /^\/c\/[a-z]+-[a-z]+-\d+#g=gt_/);
      assert.ok(isGrantKey(grantFromShareUrl(box.share_url)));
    });
  });

  it("grant reads and writes messages, but cannot delete or approve", async () => {
    await withApp({}, async (app) => {
      const box = (await createBox(app, {})).json();
      const grant = grantFromShareUrl(box.share_url);

      const post = await postMessage(app, box.box_id, grant, {
        sender: "buddy",
        body: "hello from the share link",
      });
      assert.equal(post.statusCode, 201);

      const read = await app.inject({
        method: "GET",
        url: `/v1/boxes/${box.box_id}/messages?since=0`,
        headers: auth(grant),
      });
      assert.equal(read.statusCode, 200);
      assert.ok(read.json().messages.some((m) => m.body === "hello from the share link"));

      const del = await app.inject({
        method: "DELETE",
        url: `/v1/boxes/${box.box_id}`,
        headers: auth(grant),
      });
      assert.equal(del.statusCode, 401);

      const rotate = await app.inject({
        method: "POST",
        url: `/v1/boxes/${box.box_id}/share/rotate`,
        headers: auth(grant),
      });
      assert.equal(rotate.statusCode, 401);
    });
  });

  it("rotate revokes the old grant and mints a new share link", async () => {
    await withApp({}, async (app) => {
      const box = (await createBox(app, {})).json();
      const oldGrant = grantFromShareUrl(box.share_url);
      const rotated = await app.inject({
        method: "POST",
        url: `/v1/boxes/${box.box_id}/share/rotate`,
        headers: auth(box.write_key),
      });
      assert.equal(rotated.statusCode, 200);
      const newShare = rotated.json().share_url;
      const newGrant = grantFromShareUrl(newShare);
      assert.notEqual(newGrant, oldGrant);

      const oldRead = await app.inject({
        method: "GET",
        url: `/v1/boxes/${box.box_id}/messages?since=0`,
        headers: auth(oldGrant),
      });
      assert.equal(oldRead.statusCode, 401);

      const newRead = await app.inject({
        method: "GET",
        url: `/v1/boxes/${box.box_id}/messages?since=0`,
        headers: auth(newGrant),
      });
      assert.equal(newRead.statusCode, 200);
    });
  });
});

describe("wait long-poll", { concurrency: false }, () => {
  it("returns immediately when messages already exist", async () => {
    await withApp({}, async (app) => {
      const box = (await createBox(app, {})).json();
      await postMessage(app, box.box_id, box.write_key, { sender: "a", body: "x" });
      const t0 = Date.now();
      const res = await app.inject({
        method: "GET",
        url: `/v1/boxes/${box.box_id}/messages?since=0&wait=10`,
        headers: auth(box.read_key),
      });
      assert.equal(res.statusCode, 200);
      assert.ok(res.json().messages.length >= 1);
      assert.ok(Date.now() - t0 < 3000, "should not wait when data exists");
    });
  });

  it("returns a mid-wait message instead of sleeping the full window", async () => {
    await withApp({}, async (app) => {
      const box = (await createBox(app, {})).json();
      setTimeout(() => {
        postMessage(app, box.box_id, box.write_key, { sender: "a", body: "mid-wait" });
      }, 1500);
      const t0 = Date.now();
      const res = await app.inject({
        method: "GET",
        url: `/v1/boxes/${box.box_id}/messages?since=0&wait=8`,
        headers: auth(box.read_key),
      });
      const elapsed = Date.now() - t0;
      assert.equal(res.statusCode, 200);
      assert.ok(res.json().messages.some((m) => m.body === "mid-wait"));
      assert.ok(elapsed < 7000, `waited ${elapsed}ms, expected early return`);
      assert.ok(elapsed >= 1200, `returned too fast: ${elapsed}ms`);
    });
  });

  it("returns empty after the wait window expires", async () => {
    await withApp({}, async (app) => {
      const box = (await createBox(app, {})).json();
      const t0 = Date.now();
      const res = await app.inject({
        method: "GET",
        url: `/v1/boxes/${box.box_id}/messages?since=0&wait=2`,
        headers: auth(box.read_key),
      });
      const elapsed = Date.now() - t0;
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json().messages, []);
      assert.ok(elapsed >= 1500, `returned too fast: ${elapsed}ms`);
    });
  });

  it("wait is clamped to the 30s ceiling", { timeout: 45000 }, async () => {
    await withApp({}, async (app) => {
      const box = (await createBox(app, {})).json();
      // wait=60 must be clamped to 30s, not held for a minute.
      const t0 = Date.now();
      const res = await app.inject({
        method: "GET",
        url: `/v1/boxes/${box.box_id}/messages?since=0&wait=60`,
        headers: auth(box.read_key),
      });
      const elapsed = Date.now() - t0;
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json().messages, []);
      assert.ok(elapsed >= 29000, `returned too fast: ${elapsed}ms`);
      assert.ok(elapsed < 40000, `not clamped, waited ${elapsed}ms`);
    });
  });
});

describe("chat web pages", { concurrency: false }, () => {
  it("GET /c/:box_id renders the chat shell without leaking the grant", async () => {
    await withApp({}, async (app) => {
      const box = (await createBox(app, { title: "Web Chat"})).json();
      const grant = grantFromShareUrl(box.share_url);
      const res = await app.inject({ method: "GET", url: `/c/${box.box_id}` });
      assert.equal(res.statusCode, 200);
      assert.match(res.headers["content-type"], /text\/html/);
      assert.ok(res.body.includes('id="chat"'));
      assert.ok(res.body.includes('id="name-form"'));
      assert.equal(res.body.includes(grant), false);
      assert.equal(res.body.includes("Web Chat"), false);
    });
  });

  it("GET /c/:box_id/info needs the grant; missing box is 401", async () => {
    await withApp({}, async (app) => {
      const box = (await createBox(app, { title: "Info Title"})).json();
      const grant = grantFromShareUrl(box.share_url);
      const anon = await app.inject({ method: "GET", url: `/c/${box.box_id}/info` });
      assert.equal(anon.statusCode, 401);
      const ok = await app.inject({
        method: "GET",
        url: `/c/${box.box_id}/info`,
        headers: auth(grant),
      });
      assert.equal(ok.statusCode, 200);
      assert.equal(ok.json().title, "Info Title");
      const missing = await app.inject({ method: "GET", url: "/c/nope-missing/info" });
      assert.equal(missing.statusCode, 401);
    });
  });

  it("owner rotate form issues a new share link", async () => {
    await withApp({}, async (app) => {
      const box = (await createBox(app, {})).json();
      const oldGrant = grantFromShareUrl(box.share_url);
      const res = await app.inject({
        method: "POST",
        url: "/owner/rotate",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: `box_id=${box.box_id}&write_key=${encodeURIComponent(
          box.write_key
        )}&read_key=${encodeURIComponent(box.read_key)}&title=Web+Chat+3`,
      });
      assert.equal(res.statusCode, 200);
      const m = res.body.match(/\/c\/[a-z]+-[a-z]+-\d+#g=(gt_[^"&]+)/);
      assert.ok(m, "rotated page shows a new share link");
      assert.notEqual(m[1], oldGrant);
    });
  });

  it("owner delete form deletes the chat", async () => {
    await withApp({}, async (app) => {
      const box = (await createBox(app, {})).json();
      const res = await app.inject({
        method: "POST",
        url: "/owner/delete",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: `box_id=${box.box_id}&write_key=${encodeURIComponent(box.write_key)}`,
      });
      assert.equal(res.statusCode, 200);
      assert.match(res.body, /was deleted/);
      const read = await app.inject({
        method: "GET",
        url: `/v1/boxes/${box.box_id}/messages?since=0`,
        headers: auth(box.read_key),
      });
      assert.equal(read.statusCode, 401);
    });
  });
});
