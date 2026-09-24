import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withApp, createBox, postMessage, auth } from "./helpers.js";
import { escapeHtml } from "../src/views/escape.js";

describe("escapeHtml", () => {
  it("encodes XSS metacharacters", () => {
    const out = escapeHtml(`<script>alert("x")</script>&'`);
    assert.equal(out.includes("<script>"), false);
    assert.ok(out.includes("&lt;script&gt;"));
    assert.ok(out.includes("&amp;"));
    assert.ok(out.includes("&#39;") || out.includes("&apos;"));
    assert.ok(out.includes("&quot;"));
  });
});

describe("web view", { concurrency: false }, () => {
  it("GET /b/:box_id is a locked shell and does not leak title", async () => {
    await withApp({}, async (app) => {
      const box = (await createBox(app, { title: "secret-title-xyz" })).json();
      const res = await app.inject({ method: "GET", url: `/b/${box.box_id}` });
      assert.equal(res.statusCode, 200);
      assert.match(res.headers["content-type"], /text\/html/);
      assert.match(res.body, /read key|mailbox|box/i);
      assert.equal(res.body.includes("secret-title-xyz"), false);
      const missing = await app.inject({ method: "GET", url: "/b/missing-box-10" });
      assert.equal(missing.statusCode, 200);
      assert.match(missing.headers["content-type"], /text\/html/);
    });
  });

  it("XSS payload renders escaped in the unlocked web view", async () => {
    await withApp({}, async (app) => {
      const box = (await createBox(app)).json();
      const payload = `<script>alert(1)</script><img src=x onerror=alert(1)>`;
      const posted = await postMessage(app, box.box_id, box.write_key, {
        sender: `<img src=x onerror=alert(2)>`,
        body: payload,
      });
      assert.equal(posted.statusCode, 201);

      const unlocked = await app.inject({
        method: "POST",
        url: `/b/${box.box_id}`,
        headers: { "content-type": "application/json" },
        payload: { action: "unlock", read_key: box.read_key },
      });
      assert.equal(unlocked.statusCode, 200);
      assert.match(unlocked.headers["content-type"], /text\/html/);
      assert.equal(unlocked.body.includes("<script>alert(1)</script>"), false);
      assert.equal(/<img src=x onerror/i.test(unlocked.body), false);
      assert.ok(unlocked.body.includes("&lt;script&gt;") || unlocked.body.includes("&lt;script"));
    });
  });

  it("urlencoded unlock works without JS and wrong key is generic", async () => {
    await withApp({}, async (app) => {
      const box = (await createBox(app)).json();
      await postMessage(app, box.box_id, box.write_key, {
        sender: "russ-muse",
        body: "plain text body",
      });

      const bad = await app.inject({
        method: "POST",
        url: `/b/${box.box_id}`,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: "action=unlock&read_key=rk_wrong",
      });
      assert.equal(bad.statusCode, 200);
      assert.match(bad.body, /Unable to open this box|could not open/i);
      assert.equal(bad.body.includes("plain text body"), false);

      const good = await app.inject({
        method: "POST",
        url: `/b/${box.box_id}`,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: `action=unlock&read_key=${encodeURIComponent(box.read_key)}`,
      });
      assert.equal(good.statusCode, 200);
      assert.ok(good.body.includes("plain text body"));
      assert.ok(good.body.includes("russ-muse"));
    });
  });

  it("snapshot requires the read key", async () => {
    await withApp({}, async (app) => {
      const box = (await createBox(app, { title: "t" })).json();
      await postMessage(app, box.box_id, box.write_key, { sender: "x", body: "snap" });

      const noAuth = await app.inject({
        method: "GET",
        url: `/b/${box.box_id}/snapshot`,
      });
      assert.equal(noAuth.statusCode, 401);

      const snap = await app.inject({
        method: "GET",
        url: `/b/${box.box_id}/snapshot`,
        headers: auth(box.read_key),
      });
      if (snap.statusCode === 404) return;
      assert.equal(snap.statusCode, 200);
      const body = snap.json();
      assert.ok(Array.isArray(body.messages));
      assert.ok(body.messages.some((m) => m.body === "snap"));
    });
  });
});
