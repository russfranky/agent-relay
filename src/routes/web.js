import { renderLanding, renderCreated, renderDeleted } from "../views/landing.js";
import { renderChatPage } from "../views/chat.js";
import { authorize } from "../auth.js";

function originOf(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost:8787";
  return `${proto}://${host}`;
}

export default async function webRoutes(app) {
  const { db, config } = app;

  // Landing page: name a chat, get a share link.
  app.get("/", async (req, reply) => {
    reply.type("text/html; charset=utf-8");
    return renderLanding({ origin: originOf(req) });
  });

  app.post("/", async (req, reply) => {
    reply.type("text/html; charset=utf-8");
    const origin = originOf(req);
    const body = req.body && typeof req.body === "object" ? req.body : {};
    if (body.action !== "claim") {
      return renderLanding({ origin });
    }
    const title = String(body.title || "").slice(0, 120);
    let res;
    try {
      res = await app.inject({
        method: "POST",
        url: "/v1/boxes",
        headers: { "content-type": "application/json", "x-forwarded-for": req.ip },
        payload: { title: title || undefined },
      });
    } catch {
      return renderLanding({ origin, error: "Could not create the chat link. Try again." });
    }
    if (res.statusCode !== 201) {
      let message = "Could not create the chat link. Try again.";
      try {
        const errBody = res.json();
        if (errBody?.error?.message) message = String(errBody.error.message);
      } catch {
        // keep generic message
      }
      return renderLanding({ origin, error: message });
    }
    const created = res.json();
    return renderCreated({
      origin,
      boxId: created.box_id,
      readKey: created.read_key,
      writeKey: created.write_key,
      title,
      shareUrl: created.share_url,
    });
  });

  // Owner: issue a fresh invite link (the old one stops working).
  app.post("/owner/rotate", async (req, reply) => {
    reply.type("text/html; charset=utf-8");
    const origin = originOf(req);
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const boxId = String(body.box_id || "");
    const writeKey = String(body.write_key || "");
    const readKey = String(body.read_key || "");
    const title = String(body.title || "").slice(0, 120);
    if (!boxId || !writeKey) {
      return renderLanding({ origin, error: "Missing chat or key." });
    }
    let res;
    try {
      res = await app.inject({
        method: "POST",
        url: `/v1/boxes/${encodeURIComponent(boxId)}/share/rotate`,
        headers: {
          authorization: `Bearer ${writeKey}`,
          "content-type": "application/json",
          "x-forwarded-for": req.ip,
        },
      });
    } catch {
      return renderLanding({ origin, error: "Could not make a new link. Try again." });
    }
    if (res.statusCode !== 200) {
      return renderLanding({ origin, error: "Could not make a new link. The chat may be gone." });
    }
    return renderCreated({
      origin,
      boxId,
      readKey,
      writeKey,
      title,
      shareUrl: res.json().share_url,
    });
  });

  // Owner: delete the chat.
  app.post("/owner/delete", async (req, reply) => {
    reply.type("text/html; charset=utf-8");
    const origin = originOf(req);
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const boxId = String(body.box_id || "");
    const writeKey = String(body.write_key || "");
    if (!boxId || !writeKey) {
      return renderLanding({ origin, error: "Missing chat or key." });
    }
    try {
      await app.inject({
        method: "DELETE",
        url: `/v1/boxes/${encodeURIComponent(boxId)}`,
        headers: { authorization: `Bearer ${writeKey}`, "x-forwarded-for": req.ip },
      });
    } catch {
      return renderLanding({ origin, error: "Could not delete the chat. Try again." });
    }
    return renderDeleted({ boxId });
  });

  // Human chat page. No auth at page level: the grant travels in the URL
  // fragment, which the browser never sends to the server.
  app.get("/c/:box_id", async (req, reply) => {
    reply.type("text/html; charset=utf-8");
    return renderChatPage({ boxId: req.params.box_id });
  });

  // Chat metadata for the chat page (title). Requires the share grant: a
  // chat title is private to the people holding the invite link.
  app.get("/c/:box_id/info", async (req, reply) => {
    const box = await authorize(db, config, req.params.box_id, req.headers.authorization, "read");
    return { box_id: box.id, title: box.title || null };
  });
}
