import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  withApp,
  createBox,
  postMessage,
  getMessages,
  deleteBox,
  errOf,
  uuid,
  auth,
  jsonHeaders,
} from "./helpers.js";
import { sweepExpired } from "../src/sweeper.js";
import { WORDS } from "../src/words.js";
import { generateUniqueCode, BOX_ID_RE } from "../src/codes.js";
import { hashKey } from "../src/keys.js";

function isBoxCode(id) {
  return BOX_ID_RE.test(id);
}

describe("healthz", { concurrency: false }, () => {
  it("returns ok and version without auth", async () => {
    await withApp({}, async (app) => {
      const res = await app.inject({ method: "GET", url: "/healthz" });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), { ok: true, version: "0.1.0" });
    });
  });
});

describe("lifecycle", { concurrency: false }, () => {
  it("create → write → read → poll cursor → delete", async () => {
    await withApp({}, async (app) => {
      const created = await createBox(app, { title: "demo" });
      assert.equal(created.statusCode, 201);
      const box = created.json();
      assert.ok(isBoxCode(box.box_id));
      assert.match(box.read_key, /^rk_/);
      assert.match(box.write_key, /^wk_/);
      assert.ok(box.created_at.endsWith("Z") || box.created_at.includes("T"));
      assert.ok(box.expires_at);

      const row = app.db.prepare("SELECT * FROM boxes WHERE id = ?").get(box.box_id);
      assert.equal(row.read_key_hash, hashKey(box.read_key));
      assert.equal(row.write_key_hash, hashKey(box.write_key));
      assert.ok(!JSON.stringify(row).includes(box.read_key));
      assert.ok(!JSON.stringify(row).includes(box.write_key));

      const a = await postMessage(app, box.box_id, box.write_key, {
        sender: "alice-muse",
        body: "hello",
        recipient: "bob-muse",
        client_msg_id: uuid(),
      });
      assert.equal(a.statusCode, 201);
      const msgA = a.json();
      assert.equal(msgA.sender, "alice-muse");
      assert.equal(msgA.body, "hello");
      assert.equal(msgA.box_id, box.box_id);
      assert.equal(typeof msgA.id, "number");

      const b = await postMessage(app, box.box_id, box.write_key, {
        sender: "bob-muse",
        body: "hi back",
        reply_to: msgA.id,
        client_msg_id: uuid(),
      });
      assert.equal(b.statusCode, 201);
      assert.equal(b.json().reply_to, msgA.id);

      const page1 = await getMessages(app, box.box_id, box.read_key, "?since=0&limit=1");
      assert.equal(page1.statusCode, 200);
      const p1 = page1.json();
      assert.equal(p1.messages.length, 1);
      assert.equal(p1.messages[0].id, msgA.id);
      assert.equal(p1.next_since, msgA.id);

      const page2 = await getMessages(
        app,
        box.box_id,
        box.read_key,
        `?since=${p1.next_since}`
      );
      const p2 = page2.json();
      assert.equal(p2.messages.length, 1);
      assert.equal(p2.messages[0].id, b.json().id);
      assert.equal(p2.next_since, b.json().id);

      const empty = await getMessages(
        app,
        box.box_id,
        box.read_key,
        `?since=${p2.next_since}`
      );
      assert.equal(empty.json().messages.length, 0);
      assert.equal(empty.json().next_since, p2.next_since);

      const del = await deleteBox(app, box.box_id, box.write_key);
      assert.equal(del.statusCode, 204);
      assert.equal(del.body, "");

      const gone = app.db.prepare("SELECT * FROM boxes WHERE id = ?").get(box.box_id);
      assert.equal(gone, undefined);
      const msgs = app.db
        .prepare("SELECT COUNT(*) AS n FROM messages WHERE box_id = ?")
        .get(box.box_id);
      assert.equal(msgs.n, 0);
      const tomb = app.db.prepare("SELECT * FROM tombstones WHERE id = ?").get(box.box_id);
      assert.ok(tomb);
    });
  });
});

describe("edge 1 blank fields", { concurrency: false }, () => {
  it("missing/blank sender or body → 422 validation_failed naming the field", async () => {
    await withApp({}, async (app) => {
      const box = (await createBox(app)).json();

      const cases = [
        [{ body: "hi" }, "sender"],
        [{ sender: "x" }, "body"],
        [{ sender: "   ", body: "hi" }, "sender"],
        [{ sender: "x", body: "   \n\t  " }, "body"],
        [{ sender: "x", body: "" }, "body"],
      ];
      for (const [payload, field] of cases) {
        const res = await postMessage(app, box.box_id, box.write_key, payload);
        assert.equal(res.statusCode, 422, JSON.stringify({ payload, body: res.body }));
        const err = errOf(res);
        assert.equal(err.code, "validation_failed");
        assert.match(String(err.message).toLowerCase(), new RegExp(field));
      }
    });
  });
});

describe("edge 2 oversize body", { concurrency: false }, () => {
  it("body longer than 65536 → 413 payload_too_large", async () => {
    await withApp({}, async (app) => {
      const box = (await createBox(app)).json();
      const res = await postMessage(app, box.box_id, box.write_key, {
        sender: "x",
        body: "a".repeat(65537),
      });
      assert.equal(res.statusCode, 413);
      assert.equal(errOf(res).code, "payload_too_large");
    });
  });

  it("body of exactly 65536 is accepted", async () => {
    await withApp({}, async (app) => {
      const box = (await createBox(app)).json();
      const res = await postMessage(app, box.box_id, box.write_key, {
        sender: "x",
        body: "b".repeat(65536),
      });
      assert.equal(res.statusCode, 201);
      assert.equal(res.json().body.length, 65536);
    });
  });
});

describe("edge 3/4 auth-first", { concurrency: false }, () => {
  it("missing box + any key → 401, not 404", async () => {
    await withApp({}, async (app) => {
      const res = await app.inject({
        method: "GET",
        url: "/v1/boxes/missing-box-10/messages",
        headers: auth("rk_" + "a".repeat(43)),
      });
      assert.equal(res.statusCode, 401);
      assert.equal(errOf(res).code, "unauthorized");
    });
  });

  it("existing box + wrong key → same 401 shape", async () => {
    await withApp({}, async (app) => {
      const box = (await createBox(app)).json();
      const res = await getMessages(app, box.box_id, "rk_nottherightkey_______________xx");
      assert.equal(res.statusCode, 401);
      assert.equal(errOf(res).code, "unauthorized");
    });
  });

  it("wrong key type is 401", async () => {
    await withApp({}, async (app) => {
      const box = (await createBox(app)).json();
      const writeOnGet = await getMessages(app, box.box_id, box.write_key);
      assert.equal(writeOnGet.statusCode, 401);
      const readOnPost = await postMessage(app, box.box_id, box.read_key, {
        sender: "x",
        body: "nope",
      });
      assert.equal(readOnPost.statusCode, 401);
      const readOnDelete = await deleteBox(app, box.box_id, box.read_key);
      assert.equal(readOnDelete.statusCode, 401);
    });
  });

  it("missing Authorization → 401", async () => {
    await withApp({}, async (app) => {
      const box = (await createBox(app)).json();
      const res = await app.inject({
        method: "GET",
        url: `/v1/boxes/${box.box_id}/messages`,
      });
      assert.equal(res.statusCode, 401);
      assert.equal(errOf(res).code, "unauthorized");
    });
  });

  it("unknown path → 404 not_found", async () => {
    await withApp({}, async (app) => {
      const res = await app.inject({ method: "GET", url: "/nope" });
      assert.equal(res.statusCode, 404);
      assert.equal(errOf(res).code, "not_found");
    });
  });
});

describe("edge 5 since cursor", { concurrency: false }, () => {
  it("unknown, negative, or future since returns empty list", async () => {
    await withApp({}, async (app) => {
      const box = (await createBox(app)).json();
      await postMessage(app, box.box_id, box.write_key, { sender: "x", body: "one" });

      for (const q of ["?since=-5", "?since=not-a-number", "?since=999999999"]) {
        const res = await getMessages(app, box.box_id, box.read_key, q);
        assert.equal(res.statusCode, 200, q);
        assert.equal(res.json().messages.length, 0, q);
      }
    });
  });
});

describe("edge 6 limit clamp", { concurrency: false }, () => {
  it("limit < 1 or > 200 is clamped, not an error", async () => {
    await withApp({}, async (app) => {
      const box = (await createBox(app)).json();
      for (let i = 0; i < 3; i++) {
        const r = await postMessage(app, box.box_id, box.write_key, {
          sender: "x",
          body: `m${i}`,
        });
        assert.equal(r.statusCode, 201);
      }
      const low = await getMessages(app, box.box_id, box.read_key, "?since=0&limit=0");
      assert.equal(low.statusCode, 200);
      assert.equal(low.json().messages.length, 1);

      const high = await getMessages(app, box.box_id, box.read_key, "?since=0&limit=500");
      assert.equal(high.statusCode, 200);
      assert.ok(high.json().messages.length <= 200);
      assert.equal(high.json().messages.length, 3);
    });
  });
});

describe("edge 7 idempotent client_msg_id", { concurrency: false }, () => {
  it("duplicate uuid returns original with 200 and same id", async () => {
    await withApp({}, async (app) => {
      const box = (await createBox(app)).json();
      const id = uuid();
      const first = await postMessage(app, box.box_id, box.write_key, {
        sender: "x",
        body: "first",
        client_msg_id: id,
      });
      assert.equal(first.statusCode, 201);
      const second = await postMessage(app, box.box_id, box.write_key, {
        sender: "y",
        body: "second should not write",
        client_msg_id: id,
      });
      assert.equal(second.statusCode, 200);
      assert.equal(second.json().id, first.json().id);
      assert.equal(second.json().body, "first");
      const count = app.db
        .prepare("SELECT COUNT(*) AS n FROM messages WHERE box_id = ?")
        .get(box.box_id);
      assert.equal(count.n, 1);
    });
  });

  it("malformed uuid → 422", async () => {
    await withApp({}, async (app) => {
      const box = (await createBox(app)).json();
      const res = await postMessage(app, box.box_id, box.write_key, {
        sender: "x",
        body: "hi",
        client_msg_id: "not-a-uuid",
      });
      assert.equal(res.statusCode, 422);
      assert.equal(errOf(res).code, "validation_failed");
      assert.match(errOf(res).message, /client_msg_id|uuid/i);
    });
  });
});

describe("edge 8 reply_to", { concurrency: false }, () => {
  it("nonexistent or cross-box reply_to → 422", async () => {
    await withApp({}, async (app) => {
      const a = (await createBox(app)).json();
      const b = (await createBox(app)).json();
      const other = await postMessage(app, b.box_id, b.write_key, {
        sender: "x",
        body: "other box",
      });
      assert.equal(other.statusCode, 201);

      const missing = await postMessage(app, a.box_id, a.write_key, {
        sender: "x",
        body: "no parent",
        reply_to: 999999,
      });
      assert.equal(missing.statusCode, 422);
      assert.equal(errOf(missing).code, "validation_failed");

      const cross = await postMessage(app, a.box_id, a.write_key, {
        sender: "x",
        body: "cross",
        reply_to: other.json().id,
      });
      assert.equal(cross.statusCode, 422);
      assert.equal(errOf(cross).code, "validation_failed");
    });
  });
});

describe("edge 9 box_full", { concurrency: false }, () => {
  it("returns 409 box_full and does not drop the write silently", async () => {
    await withApp({ MAX_BOX_MESSAGES: 2 }, async (app) => {
      const box = (await createBox(app)).json();
      assert.equal(
        (await postMessage(app, box.box_id, box.write_key, { sender: "x", body: "1" }))
          .statusCode,
        201
      );
      assert.equal(
        (await postMessage(app, box.box_id, box.write_key, { sender: "x", body: "2" }))
          .statusCode,
        201
      );
      const full = await postMessage(app, box.box_id, box.write_key, {
        sender: "x",
        body: "3",
      });
      assert.equal(full.statusCode, 409);
      assert.equal(errOf(full).code, "box_full");
      assert.match(errOf(full).message, /delete|retention/i);
      const count = app.db
        .prepare("SELECT COUNT(*) AS n FROM messages WHERE box_id = ?")
        .get(box.box_id);
      assert.equal(count.n, 2);
    });
  });
});

describe("edge 10 expiry + sweeper", { concurrency: false }, () => {
  it("expired box returns 410 and sweeper hard-deletes with tombstone", async () => {
    await withApp({ RETENTION_DAYS: 1 }, async (app) => {
      const box = (await createBox(app)).json();
      await postMessage(app, box.box_id, box.write_key, { sender: "x", body: "old" });
      app.db
        .prepare("UPDATE boxes SET last_activity_at = ? WHERE id = ?")
        .run("2000-01-01T00:00:00.000Z", box.box_id);

      const read = await getMessages(app, box.box_id, box.read_key);
      assert.equal(read.statusCode, 410);
      assert.equal(errOf(read).code, "gone_expired");

      const write = await postMessage(app, box.box_id, box.write_key, {
        sender: "x",
        body: "too late",
      });
      // First access 410-and-lazy-deletes; a follow-up may be 410 or 401.
      assert.ok([410, 401].includes(write.statusCode), write.body);

      const leftover = (await createBox(app)).json();
      app.db
        .prepare("UPDATE boxes SET last_activity_at = ? WHERE id = ?")
        .run("2000-01-01T00:00:00.000Z", leftover.box_id);
      const n = await sweepExpired(app.db, app.config);
      assert.ok(n >= 1);
      assert.equal(
        app.db.prepare("SELECT * FROM boxes WHERE id = ?").get(box.box_id),
        undefined
      );
      assert.equal(
        app.db.prepare("SELECT * FROM boxes WHERE id = ?").get(leftover.box_id),
        undefined
      );
      assert.ok(app.db.prepare("SELECT * FROM tombstones WHERE id = ?").get(box.box_id));
    });
  });
});

describe("edge 11 concurrent writes", { concurrency: false }, () => {
  it("parallel POSTs get unique ids", async () => {
    await withApp({ RATE_LIMIT_WRITES_PER_MIN: 1000, RATE_LIMIT_IP_WRITES_PER_MIN: 1000 }, async (app) => {
      const box = (await createBox(app)).json();
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          postMessage(app, box.box_id, box.write_key, {
            sender: "x",
            body: `c${i}`,
            client_msg_id: uuid(),
          })
        )
      );
      for (const r of results) assert.equal(r.statusCode, 201);
      const ids = results.map((r) => r.json().id);
      assert.equal(new Set(ids).size, ids.length);
      const sorted = [...ids].sort((a, b) => a - b);
      assert.deepEqual(ids.slice().sort((a, b) => a - b), sorted);
    });
  });
});

describe("edge 12 rate limits", { concurrency: false }, () => {
  it("per-key writes 429 with Retry-After", async () => {
    await withApp(
      {
        RATE_LIMIT_WRITES_PER_MIN: 2,
        RATE_LIMIT_IP_WRITES_PER_MIN: 1000,
        RATE_LIMIT_CREATE_PER_IP_PER_DAY: 100,
      },
      async (app) => {
        const box = (await createBox(app)).json();
        assert.equal(
          (await postMessage(app, box.box_id, box.write_key, { sender: "x", body: "1" }))
            .statusCode,
          201
        );
        assert.equal(
          (await postMessage(app, box.box_id, box.write_key, { sender: "x", body: "2" }))
            .statusCode,
          201
        );
        const limited = await postMessage(app, box.box_id, box.write_key, {
          sender: "x",
          body: "3",
        });
        assert.equal(limited.statusCode, 429);
        assert.equal(errOf(limited).code, "rate_limited");
        assert.ok(limited.headers["retry-after"]);
      }
    );
  });

  it("create-per-ip daily limit 429s", async () => {
    await withApp(
      {
        RATE_LIMIT_CREATE_PER_IP_PER_DAY: 2,
        RATE_LIMIT_IP_WRITES_PER_MIN: 1000,
      },
      async (app) => {
        assert.equal((await createBox(app)).statusCode, 201);
        assert.equal((await createBox(app)).statusCode, 201);
        const third = await createBox(app);
        assert.equal(third.statusCode, 429);
        assert.equal(errOf(third).code, "rate_limited");
      }
    );
  });

  it("omitting auth still hits the IP floor", async () => {
    await withApp(
      {
        RATE_LIMIT_IP_WRITES_PER_MIN: 2,
        RATE_LIMIT_WRITES_PER_MIN: 1000,
        RATE_LIMIT_CREATE_PER_IP_PER_DAY: 100,
      },
      async (app) => {
        const box = (await createBox(app)).json();
        const unauth = () =>
          app.inject({
            method: "POST",
            url: `/v1/boxes/${box.box_id}/messages`,
            headers: jsonHeaders(),
            payload: { sender: "x", body: "nope" },
          });
        const r1 = await unauth();
        assert.ok([401, 429].includes(r1.statusCode));
        const r2 = await unauth();
        assert.equal(r2.statusCode, 429);
        assert.equal(errOf(r2).code, "rate_limited");
      }
    );
  });
});

describe("edge 13 CORS", { concurrency: false }, () => {
  it("allows any origin on API routes", async () => {
    await withApp({}, async (app) => {
      const res = await app.inject({
        method: "GET",
        url: "/healthz",
        headers: { origin: "https://agents.example" },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers["access-control-allow-origin"], "https://agents.example");
    });
  });
});

describe("edge 16 timestamps are server UTC", { concurrency: false }, () => {
  it("ignores client-supplied created_at", async () => {
    await withApp({}, async (app) => {
      const box = (await createBox(app)).json();
      const res = await postMessage(app, box.box_id, box.write_key, {
        sender: "x",
        body: "ts",
        created_at: "1999-01-01T00:00:00.000Z",
      });
      assert.equal(res.statusCode, 201);
      assert.notEqual(res.json().created_at, "1999-01-01T00:00:00.000Z");
      assert.match(res.json().created_at, /^\d{4}-\d{2}-\d{2}T/);
    });
  });
});

describe("edge 18 tombstones", { concurrency: false }, () => {
  it("deleted ids are reserved and generateUniqueCode skips them", async () => {
    await withApp({}, async (app) => {
      const box = (await createBox(app)).json();
      const id = box.box_id;
      await deleteBox(app, id, box.write_key);
      const exists = (code) =>
        Boolean(
          app.db.prepare("SELECT 1 FROM boxes WHERE id = ?").get(code) ||
            app.db.prepare("SELECT 1 FROM tombstones WHERE id = ?").get(code)
        );
      assert.equal(exists(id), true);
      assert.equal(generateUniqueCode((c) => c === id || exists(c), 8) === id, false);

      const after = await getMessages(app, id, box.read_key);
      assert.equal(after.statusCode, 401);
    });
  });
});

describe("edge 19 internal errors", { concurrency: false }, () => {
  it("500 has internal code and no stack", async () => {
    await withApp({}, async (app) => {
      app.db.close();
      const res = await createBox(app);
      assert.equal(res.statusCode, 500);
      const body = res.json();
      assert.equal(body.error.code, "internal");
      assert.ok(!/at\s+\S+\s+\(/.test(res.body));
      assert.ok(!String(body.error.message).includes("sqlite"));
    });
  });
});

describe("edge 20 title cap", { concurrency: false }, () => {
  it("title over 120 chars → 422", async () => {
    await withApp({}, async (app) => {
      const res = await createBox(app, { title: "t".repeat(121) });
      assert.equal(res.statusCode, 422);
      assert.equal(errOf(res).code, "validation_failed");
      assert.match(errOf(res).message, /title/i);
    });
  });

  it("title of 120 chars is accepted", async () => {
    await withApp({}, async (app) => {
      const res = await createBox(app, { title: "t".repeat(120) });
      assert.equal(res.statusCode, 201);
    });
  });
});

describe("word list and codes", { concurrency: false }, () => {
  it("has ~200 unique words and generates valid codes", async () => {
    assert.ok(WORDS.length >= 180);
    assert.equal(new Set(WORDS).size, WORDS.length);
    const code = generateUniqueCode(() => false);
    assert.match(code, BOX_ID_RE);
    const [a, b, n] = code.split("-");
    assert.ok(WORDS.includes(a));
    assert.ok(WORDS.includes(b));
    const num = Number(n);
    assert.ok(num >= 10 && num <= 99);
  });
});
