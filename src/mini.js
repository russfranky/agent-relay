import http from "node:http";
import { URL } from "node:url";

function pathToRegex(path) {
  const keys = [];
  const re = path.replace(/:([A-Za-z0-9_]+)/g, (_, k) => {
    keys.push(k);
    return "([^/]+)";
  });
  return { keys, regex: new RegExp(`^${re}$`) };
}

class Reply {
  constructor(res) {
    this.raw = res;
    this.statusCode = 200;
    this.headers = {};
    this.sent = false;
    this.hijacked = false;
    this.payload = undefined;
  }
  code(n) {
    this.statusCode = n;
    return this;
  }
  header(k, v) {
    this.headers[String(k).toLowerCase()] = String(v);
    return this;
  }
  type(v) {
    return this.header("content-type", v);
  }
  // Hand the raw response to the route (long-lived streams). The route
  // owns the socket from here; the framework must not touch it.
  // Requires req.rawRes (a live HTTP connection, not inject()).
  hijack() {
    this.hijacked = true;
    this.sent = true;
    return this;
  }
  send(body) {
    this.payload = body === undefined ? null : body;
    this.sent = true;
    return this;
  }
}

export function createApp() {
  const routes = [];
  const onClose = [];
  const parsers = new Map();
  let errorHandler = (err, req, reply) => {
    reply.code(500).send({ error: { code: "internal", message: "internal error" } });
  };
  let notFoundHandler = (req, reply) => {
    reply.code(404).send({ error: { code: "not_found", message: "not found" } });
  };
  const log = {
    info() {},
    error() {},
    warn() {},
    debug() {},
  };

  parsers.set("application/json", (raw) => {
    if (!raw || !String(raw).trim()) return {};
    return JSON.parse(raw);
  });
  parsers.set("application/x-www-form-urlencoded", (raw) => {
    const out = {};
    for (const part of String(raw || "").split("&")) {
      if (!part) continue;
      const eq = part.indexOf("=");
      const k = decodeURIComponent((eq === -1 ? part : part.slice(0, eq)).replace(/\+/g, " "));
      const v = decodeURIComponent((eq === -1 ? "" : part.slice(eq + 1)).replace(/\+/g, " "));
      out[k] = v;
    }
    return out;
  });

  const app = {
    log,
    decorate(name, value) {
      app[name] = value;
    },
    addHook(name, fn) {
      if (name === "onClose") onClose.push(fn);
    },
    setErrorHandler(fn) {
      errorHandler = fn;
    },
    setNotFoundHandler(fn) {
      notFoundHandler = fn;
    },
    hasContentTypeParser(ct) {
      return parsers.has(ct);
    },
    removeContentTypeParser() {},
    addContentTypeParser(ct, _opts, fn) {
      if (typeof _opts === "function") fn = _opts;
      parsers.set(ct, (raw) => {
        return new Promise((resolve, reject) => {
          fn({}, raw, (err, val) => (err ? reject(err) : resolve(val)));
        });
      });
    },
    register(plugin, opts) {
      return Promise.resolve(plugin(app, opts));
    },
    route(method, path, handler) {
      const { keys, regex } = pathToRegex(path);
      routes.push({ method: method.toUpperCase(), path, keys, regex, handler });
    },
    // Fastify-style (path, [opts], handler). opts are accepted and ignored;
    // stream routes detect a live socket via req.rawRes themselves.
    _withOpts(path, a, b) {
      if (typeof a === "function") return { opts: {}, handler: a };
      return { opts: a || {}, handler: b };
    },
    get(path, a, b) {
      const { handler } = app._withOpts(path, a, b);
      app.route("GET", path, handler);
    },
    post(path, a, b) {
      const { handler } = app._withOpts(path, a, b);
      app.route("POST", path, handler);
    },
    delete(path, a, b) {
      const { handler } = app._withOpts(path, a, b);
      app.route("DELETE", path, handler);
    },
    options(path, a, b) {
      const { handler } = app._withOpts(path, a, b);
      app.route("OPTIONS", path, handler);
    },
    async ready() {
      return app;
    },
    async close() {
      for (const fn of onClose) await fn();
      if (app.server) await new Promise((r) => app.server.close(r));
    },
    async handle(reqLike) {
      const method = (reqLike.method || "GET").toUpperCase();
      const url = new URL(reqLike.url, "http://127.0.0.1");
      const headers = {};
      for (const [k, v] of Object.entries(reqLike.headers || {})) {
        headers[k.toLowerCase()] = v;
      }
      const req = {
        method,
        url: url.pathname + url.search,
        headers,
        params: {},
        query: Object.fromEntries(url.searchParams.entries()),
        body: reqLike.body,
        ip: headers["x-forwarded-for"]?.split(",")[0]?.trim() || "127.0.0.1",
        protocol: "http",
        log,
        // Live HTTP response, present only outside inject(). Stream routes
        // use it via reply.hijack().
        rawRes: reqLike.rawRes || null,
      };
      if (req.body === undefined && reqLike.payload !== undefined) {
        const ct = (headers["content-type"] || "").split(";")[0].trim();
        const raw = reqLike.payload;
        if (typeof raw === "string" && parsers.has(ct)) {
          req.body = parsers.get(ct)(raw);
        } else {
          req.body = raw;
        }
      }
      const reply = new Reply(null);

      if (headers.origin) {
        reply.header("access-control-allow-origin", headers.origin);
        reply.header("access-control-allow-headers", "Authorization, Content-Type");
        reply.header("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
        reply.header("vary", "Origin");
      }
      if (method === "OPTIONS") {
        reply.code(204).send(null);
        return reply;
      }

      const match = routes.find((r) => r.method === method && r.regex.test(url.pathname));
      try {
        if (!match) {
          await notFoundHandler(req, reply);
        } else {
          const m = url.pathname.match(match.regex);
          match.keys.forEach((k, i) => {
            req.params[k] = decodeURIComponent(m[i + 1]);
          });
          const result = await match.handler(req, reply);
          if (reply.hijacked) return reply;
          if (!reply.sent && result !== undefined) reply.send(result);
        }
      } catch (err) {
        await errorHandler(err, req, reply);
      }
      return reply;
    },
    async inject(opts) {
      const reply = await app.handle(opts);
      let payload = reply.payload;
      let body;
      if (payload == null) body = "";
      else if (typeof payload === "string" || Buffer.isBuffer(payload)) body = String(payload);
      else body = JSON.stringify(payload);
      const headers = { ...reply.headers };
      if (!headers["content-type"] && payload && typeof payload === "object") {
        headers["content-type"] = "application/json; charset=utf-8";
      }
      return {
        statusCode: reply.statusCode,
        headers,
        body,
        payload: body,
        json() {
          return body ? JSON.parse(body) : null;
        },
      };
    },
    listen({ port, host }) {
      return new Promise((resolve, reject) => {
        const server = http.createServer(async (req, res) => {
          const chunks = [];
          for await (const c of req) chunks.push(c);
          const raw = Buffer.concat(chunks).toString("utf8");
          const ct = (req.headers["content-type"] || "").split(";")[0].trim();
          let body;
          try {
            const parser = parsers.get(ct);
            body = parser ? await parser(raw) : raw || undefined;
          } catch {
            res.statusCode = 400;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: { code: "validation_failed", message: "invalid body" } }));
            return;
          }
          const reply = await app.handle({
            method: req.method,
            url: req.url,
            headers: req.headers,
            body,
            rawRes: res,
          });
          if (reply.hijacked) return; // route owns the socket now
          res.statusCode = reply.statusCode;
          for (const [k, v] of Object.entries(reply.headers)) res.setHeader(k, v);
          let out = reply.payload;
          if (out == null) {
            res.end();
            return;
          }
          if (typeof out !== "string" && !Buffer.isBuffer(out)) {
            if (!reply.headers["content-type"]) res.setHeader("content-type", "application/json; charset=utf-8");
            out = JSON.stringify(out);
          }
          res.end(out);
        });
        app.server = server;
        server.listen(port, host, (err) => (err ? reject(err) : resolve(server)));
      });
    },
  };
  return app;
}
