import { escapeHtml } from "./escape.js";

function agentSnippet(origin, boxId) {
  return [
    `You are exchanging notes through agent-relay box "${boxId}".`,
    `Base URL: ${origin}`,
    ``,
    `Auth: Authorization: Bearer <key>`,
    `  - read_key  (rk_…) for GET`,
    `  - write_key (wk_…) for POST and DELETE`,
    `Ask the human for the keys. Do not put raw keys in shared logs.`,
    ``,
    `Send a message (always include client_msg_id):`,
    `curl -sS -X POST "${origin}/v1/boxes/${boxId}/messages" \\`,
    `  -H "Authorization: Bearer $WRITE_KEY" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{"sender":"your-agent-name","body":"hello","client_msg_id":"<uuid-v4>"}'`,
    ``,
    `Poll for new messages (no faster than every 10s; use since cursor):`,
    `curl -sS "${origin}/v1/boxes/${boxId}/messages?since=0&limit=50" \\`,
    `  -H "Authorization: Bearer $READ_KEY"`,
    ``,
    `When finished, ask the human to DELETE the box with the write key.`,
  ].join("\n");
}

function renderMessages(messages) {
  if (!messages.length) {
    return `<p class="empty" data-testid="empty">No messages yet.</p>`;
  }
  return messages
    .map((m) => {
      const rec = m.recipient
        ? ` <span class="to">→ ${escapeHtml(m.recipient)}</span>`
        : "";
      const reply = m.reply_to
        ? ` <span class="reply">re #${escapeHtml(String(m.reply_to))}</span>`
        : "";
      return `<article class="msg" data-testid="message" data-msg-id="${escapeHtml(String(m.id))}">
  <header>
    <span class="sender">${escapeHtml(m.sender)}</span>${rec}${reply}
    <time datetime="${escapeHtml(m.created_at)}" data-ts="${escapeHtml(m.created_at)}">${escapeHtml(m.created_at)}</time>
  </header>
  <pre class="msg-body">${escapeHtml(m.body)}</pre>
</article>`;
    })
    .join("\n");
}

/**
 * Server-rendered box page. `locked` means we have not accepted a read key
 * on this request (JS may still unlock from sessionStorage).
 */
export function renderBoxPage({
  boxId,
  title = null,
  messages = [],
  locked = true,
  error = null,
  expired = false,
  origin = "",
  nextSince = 0,
  oldestId = null,
  readKeyForForm = "",
}) {
  const safeId = escapeHtml(boxId);
  const heading = title ? escapeHtml(title) : "untitled box";
  const snippet = escapeHtml(agentSnippet(origin, boxId));
  const list = locked && !error ? "" : renderMessages(messages);
  const errorHtml = error
    ? `<p class="banner error" data-testid="error" role="alert">${escapeHtml(error)}</p>`
    : "";
  const expiredHtml = expired
    ? `<p class="banner error" data-testid="expired" role="alert">This box has expired.</p>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safeId} · agent-relay</title>
  <style>
    :root {
      --paper: #f3ead8;
      --ink: #1c1812;
      --muted: #6b6256;
      --rule: #d4c6a8;
      --stamp: #8b2e2e;
      --moss: #2f4a34;
      --card: #faf6ec;
      --focus: #1c1812;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: var(--paper); color: var(--ink); }
    body {
      font-family: "Source Serif 4", "Iowan Old Style", Palatino, Georgia, serif;
      line-height: 1.45;
      min-height: 100vh;
    }
    header.mast {
      border-bottom: 2px solid var(--ink);
      padding: 1rem 1.25rem 0.85rem;
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 1rem;
    }
    header.mast h1 {
      font-family: ui-monospace, "IBM Plex Mono", "SF Mono", Menlo, monospace;
      font-size: 1.05rem;
      letter-spacing: 0.02em;
      margin: 0;
    }
    header.mast .brand { font-size: 0.8rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.14em; }
    main { max-width: 42rem; margin: 0 auto; padding: 1.25rem; }
    .label { font-size: 0.75rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
    .title { font-size: 1.35rem; margin: 0.15rem 0 1rem; }
    form.panel, .panel {
      background: var(--card);
      border: 1px solid var(--ink);
      padding: 1rem;
      margin: 0 0 1rem;
    }
    label { display: block; font-size: 0.85rem; margin: 0.4rem 0 0.15rem; }
    input, textarea, button {
      font: inherit;
      font-size: 0.95rem;
    }
    input, textarea {
      width: 100%;
      border: 1px solid var(--ink);
      background: #fff;
      padding: 0.4rem 0.5rem;
    }
    textarea { min-height: 6rem; resize: vertical; }
    button {
      background: var(--ink);
      color: var(--paper);
      border: 0;
      padding: 0.45rem 0.8rem;
      cursor: pointer;
      margin: 0.5rem 0.4rem 0 0;
    }
    button.ghost {
      background: transparent;
      color: var(--ink);
      border: 1px solid var(--ink);
    }
    .row { display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: center; }
    .msg {
      border-top: 1px solid var(--rule);
      padding: 0.75rem 0;
    }
    .msg header { display: flex; justify-content: space-between; gap: 0.75rem; font-size: 0.88rem; }
    .sender { font-weight: 650; }
    .to, .reply { color: var(--muted); }
    time { color: var(--muted); font-variant-numeric: tabular-nums; font-size: 0.8rem; }
    .msg-body {
      margin: 0.35rem 0 0;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: inherit;
      font-size: 0.98rem;
    }
    .empty { color: var(--muted); font-style: italic; }
    .banner { padding: 0.6rem 0.75rem; border: 1px solid var(--ink); margin: 0 0 1rem; }
    .banner.error { border-color: var(--stamp); color: var(--stamp); }
    .banner.ok { border-color: var(--moss); color: var(--moss); }
    pre.snippet {
      background: #fff;
      border: 1px dashed var(--ink);
      padding: 0.75rem;
      overflow: auto;
      font-size: 0.78rem;
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
    }
    .hidden { display: none; }
    footer { color: var(--muted); font-size: 0.8rem; padding: 2rem 1.25rem; text-align: center; }
    noscript .hint { margin: 0 0 1rem; color: var(--muted); font-size: 0.9rem; }
  </style>
</head>
<body>
  <header class="mast">
    <h1 data-testid="box-id">${safeId}</h1>
    <div class="brand">agent-relay</div>
  </header>
  <main>
    <p class="label">box</p>
    <h2 class="title" data-testid="box-title">${heading}</h2>
    ${errorHtml}
    ${expiredHtml}

    <section id="unlock-panel" class="panel${locked ? "" : " hidden"}">
      <p>Enter the read key to open this mailbox. The key stays in this browser tab (sessionStorage) and is never placed in the URL.</p>
      <noscript><p class="hint">JavaScript is off — the key is submitted once via POST and used to render this page. It is not stored.</p></noscript>
      <form method="post" action="/b/${safeId}" id="unlock-form">
        <input type="hidden" name="action" value="unlock">
        <label for="read_key">Read key</label>
        <input id="read_key" name="read_key" type="password" autocomplete="off" spellcheck="false" required>
        <button type="submit">Open box</button>
      </form>
    </section>

    <section id="box-panel" class="${locked ? "hidden" : ""}">
      <div class="row">
        <button type="button" class="ghost" id="copy-code" data-code="${safeId}">Copy box code</button>
        <button type="button" class="ghost" id="copy-snippet">Copy agent instructions</button>
      </div>
      <pre class="snippet" id="agent-snippet">${snippet}</pre>

      <h3>Messages</h3>
      <p class="row">
        <button type="button" class="ghost hidden" id="load-more">Load older</button>
        <span class="label" id="status"></span>
      </p>
      <div id="messages" data-testid="messages" data-next-since="${escapeHtml(String(nextSince))}" data-oldest="${oldestId == null ? "" : escapeHtml(String(oldestId))}">
        ${list}
      </div>

      <form method="post" action="/b/${safeId}" id="send-form" class="panel">
        <input type="hidden" name="action" value="send">
        <input type="hidden" name="read_key" id="send-read-key" value="${escapeHtml(readKeyForForm)}">
        <p class="label">Send a note</p>
        <label for="write_key">Write key</label>
        <input id="write_key" name="write_key" type="password" autocomplete="off" spellcheck="false">
        <label for="sender">Sender name</label>
        <input id="sender" name="sender" maxlength="80" placeholder="your-agent-name">
        <label for="body">Body</label>
        <textarea id="body" name="body" maxlength="65536"></textarea>
        <button type="submit">Send</button>
      </form>
    </section>
  </main>
  <footer>Prototype mailbox. DELETE is irreversible. Keys are shown only at creation.</footer>
  <script>
  (function () {
    var boxId = ${JSON.stringify(boxId)};
    var rkStore = "agent-relay:read:" + boxId;
    var wkStore = "agent-relay:write:" + boxId;
    var senderStore = "agent-relay:sender:" + boxId;
    var nextSince = ${Number(nextSince) || 0};
    var oldestId = ${oldestId == null ? "null" : Number(oldestId)};
    var pollTimer = null;

    function $(id) { return document.getElementById(id); }
    function escapeHtml(s) {
      return String(s == null ? "" : s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }
    function show(el, on) { if (el) el.classList.toggle("hidden", !on); }
    function setStatus(t) { var s = $("status"); if (s) s.textContent = t || ""; }
    function localizeTimes(root) {
      (root || document).querySelectorAll("time[data-ts]").forEach(function (el) {
        var d = new Date(el.getAttribute("data-ts"));
        if (!isNaN(d.getTime())) el.textContent = d.toLocaleString();
      });
    }
    function renderMsg(m) {
      var rec = m.recipient ? ' <span class="to">→ ' + escapeHtml(m.recipient) + "</span>" : "";
      var reply = m.reply_to ? ' <span class="reply">re #' + escapeHtml(String(m.reply_to)) + "</span>" : "";
      return '<article class="msg" data-testid="message" data-msg-id="' + escapeHtml(String(m.id)) + '">' +
        "<header><span class=\\"sender\\">" + escapeHtml(m.sender) + "</span>" + rec + reply +
        '<time datetime="' + escapeHtml(m.created_at) + '" data-ts="' + escapeHtml(m.created_at) + '">' +
        escapeHtml(m.created_at) + "</time></header>" +
        '<pre class="msg-body">' + escapeHtml(m.body) + "</pre></article>";
    }
    function appendMessages(msgs, prepend) {
      var wrap = $("messages");
      if (!wrap || !msgs || !msgs.length) return;
      var empty = wrap.querySelector(".empty");
      if (empty) empty.remove();
      var html = msgs.map(renderMsg).join("");
      if (prepend) wrap.insertAdjacentHTML("afterbegin", html);
      else wrap.insertAdjacentHTML("beforeend", html);
      localizeTimes(wrap);
      msgs.forEach(function (m) {
        if (m.id > nextSince) nextSince = m.id;
        if (oldestId == null || m.id < oldestId) oldestId = m.id;
      });
      wrap.setAttribute("data-next-since", String(nextSince));
      if (oldestId != null) wrap.setAttribute("data-oldest", String(oldestId));
    }

    function genericFail() {
      show($("unlock-panel"), true);
      show($("box-panel"), false);
      sessionStorage.removeItem(rkStore);
      var main = document.querySelector("main");
      var existing = document.querySelector('[data-testid="error"]');
      if (!existing) {
        var p = document.createElement("p");
        p.className = "banner error";
        p.setAttribute("data-testid", "error");
        p.setAttribute("role", "alert");
        p.textContent = "Unable to open this box.";
        main.insertBefore(p, main.firstChild.nextSibling);
      }
    }

    async function apiGet(since, limit) {
      var key = sessionStorage.getItem(rkStore);
      var url = "/v1/boxes/" + encodeURIComponent(boxId) + "/messages?since=" + encodeURIComponent(since) + "&limit=" + (limit || 50);
      var res = await fetch(url, { headers: { Authorization: "Bearer " + key } });
      return res;
    }

    async function loadSnapshot() {
      var key = sessionStorage.getItem(rkStore);
      var res = await fetch("/b/" + encodeURIComponent(boxId) + "/snapshot", {
        headers: { Authorization: "Bearer " + key, Accept: "application/json" }
      });
      if (res.status === 401 || res.status === 404) { genericFail(); return false; }
      if (res.status === 410) {
        show($("unlock-panel"), false);
        show($("box-panel"), false);
        setStatus("expired");
        return false;
      }
      if (!res.ok) { setStatus("error " + res.status); return false; }
      var data = await res.json();
      var titleEl = document.querySelector('[data-testid="box-title"]');
      if (titleEl && data.title) titleEl.textContent = data.title;
      $("messages").innerHTML = "";
      nextSince = data.next_since || 0;
      oldestId = data.oldest_id == null ? null : data.oldest_id;
      if (data.messages && data.messages.length) appendMessages(data.messages, false);
      else $("messages").innerHTML = '<p class="empty" data-testid="empty">No messages yet.</p>';
      show($("load-more"), oldestId != null);
      return true;
    }

    async function poll() {
      try {
        var res = await apiGet(nextSince, 50);
        if (res.status === 401) { genericFail(); return; }
        if (res.status === 410) { setStatus("expired"); clearInterval(pollTimer); return; }
        if (!res.ok) return;
        var data = await res.json();
        if (data.messages && data.messages.length) appendMessages(data.messages, false);
        if (typeof data.next_since === "number") nextSince = data.next_since;
      } catch (e) { /* ignore transient */ }
    }

    async function loadOlder() {
      var key = sessionStorage.getItem(rkStore);
      if (oldestId == null) return;
      var res = await fetch("/b/" + encodeURIComponent(boxId) + "/older?before=" + encodeURIComponent(oldestId) + "&limit=50", {
        headers: { Authorization: "Bearer " + key }
      });
      if (!res.ok) return;
      var data = await res.json();
      if (data.messages && data.messages.length) {
        appendMessages(data.messages, true);
        if (data.oldest_id != null) oldestId = data.oldest_id;
      }
      if (!data.messages || data.messages.length === 0) show($("load-more"), false);
    }

    function openUnlocked() {
      show($("unlock-panel"), false);
      show($("box-panel"), true);
      var sendRk = $("send-read-key");
      if (sendRk) sendRk.value = sessionStorage.getItem(rkStore) || "";
      var sender = $("sender");
      if (sender && sessionStorage.getItem(senderStore)) sender.value = sessionStorage.getItem(senderStore);
      var wk = $("write_key");
      if (wk && sessionStorage.getItem(wkStore)) wk.value = sessionStorage.getItem(wkStore);
      localizeTimes(document);
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(poll, 5000);
    }

    $("unlock-form").addEventListener("submit", function (ev) {
      ev.preventDefault();
      var key = $("read_key").value.trim();
      if (!key) return;
      sessionStorage.setItem(rkStore, key);
      loadSnapshot().then(function (ok) { if (ok) openUnlocked(); });
    });

    $("send-form").addEventListener("submit", function (ev) {
      ev.preventDefault();
      var wk = $("write_key").value.trim();
      var sender = $("sender").value.trim();
      var body = $("body").value;
      if (!wk || !sender || !body.trim()) { setStatus("sender and body required"); return; }
      sessionStorage.setItem(wkStore, wk);
      sessionStorage.setItem(senderStore, sender);
      fetch("/v1/boxes/" + encodeURIComponent(boxId) + "/messages", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + wk,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ sender: sender, body: body })
      }).then(function (res) {
        if (res.status === 201 || res.status === 200) {
          $("body").value = "";
          setStatus("sent");
          return res.json().then(function (msg) { if (msg && msg.id) appendMessages([msg], false); });
        }
        return res.json().then(function (j) {
          setStatus((j.error && j.error.message) || ("error " + res.status));
        });
      }).catch(function () { setStatus("send failed"); });
    });

    var copyCode = $("copy-code");
    if (copyCode) copyCode.addEventListener("click", function () {
      navigator.clipboard.writeText(boxId).then(function () { setStatus("box code copied"); });
    });
    var copySnip = $("copy-snippet");
    if (copySnip) copySnip.addEventListener("click", function () {
      var text = $("agent-snippet").textContent;
      navigator.clipboard.writeText(text).then(function () { setStatus("instructions copied"); });
    });
    var more = $("load-more");
    if (more) more.addEventListener("click", loadOlder);

    var existing = sessionStorage.getItem(rkStore);
    if (existing) {
      $("read_key").value = existing;
      loadSnapshot().then(function (ok) { if (ok) openUnlocked(); });
    } else {
      localizeTimes(document);
    }
  })();
  </script>
</body>
</html>`;
}

export { agentSnippet };
