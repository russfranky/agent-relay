import { escapeHtml } from "./escape.js";

const CSS = `
    :root {
      --paper: #f3ead8;
      --ink: #1c1812;
      --muted: #6b6256;
      --rule: #d4c6a8;
      --stamp: #8b2e2e;
      --moss: #2f4a34;
      --card: #faf6ec;
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
    header.mast h1 { font-size: 1.05rem; letter-spacing: 0.02em; margin: 0; }
    header.mast .brand { font-size: 0.8rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.14em; }
    main { max-width: 42rem; margin: 0 auto; padding: 1.25rem; }
    .label { font-size: 0.75rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
    .title { font-size: 1.6rem; margin: 0.15rem 0 0.75rem; }
    .panel {
      background: var(--card);
      border: 1px solid var(--ink);
      padding: 1rem;
      margin: 0 0 1rem;
    }
    label { display: block; font-size: 0.85rem; margin: 0.4rem 0 0.15rem; }
    input, textarea, button { font: inherit; font-size: 0.95rem; }
    input, textarea {
      width: 100%;
      border: 1px solid var(--ink);
      background: #fff;
      padding: 0.4rem 0.5rem;
    }
    button {
      background: var(--ink);
      color: var(--paper);
      border: 0;
      padding: 0.45rem 0.8rem;
      cursor: pointer;
      margin: 0.5rem 0.4rem 0 0;
    }
    button.ghost { background: transparent; color: var(--ink); border: 1px solid var(--ink); }
    button.danger { background: var(--stamp); }
    .steps { padding-left: 1.2rem; }
    .steps li { margin: 0.35rem 0; }
    .banner { padding: 0.6rem 0.75rem; border: 1px solid var(--ink); margin: 0 0 1rem; }
    .banner.error { border-color: var(--stamp); color: var(--stamp); }
    .banner.ok { border-color: var(--moss); color: var(--moss); }
    .sharebox {
      display: flex;
      gap: 0.5rem;
      margin: 0.75rem 0;
    }
    .sharebox input {
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      font-size: 0.8rem;
    }
    .sharebox button { margin: 0; white-space: nowrap; }
    .keyrow {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 0.75rem;
      border-top: 1px solid var(--rule);
      padding: 0.5rem 0;
      font-size: 0.9rem;
    }
    .keyrow code {
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      font-size: 0.8rem;
      word-break: break-all;
    }
    pre.snippet {
      background: #fff;
      border: 1px dashed var(--ink);
      padding: 0.75rem;
      overflow: auto;
      font-size: 0.78rem;
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
    }
    details.owner { margin-top: 1rem; }
    details.owner summary { cursor: pointer; font-size: 0.9rem; color: var(--muted); }
    a { color: var(--ink); }
    footer { color: var(--muted); font-size: 0.8rem; padding: 2rem 1.25rem; text-align: center; }
    .hint { color: var(--muted); font-size: 0.85rem; }
`;

function shell(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · agent-relay</title>
  <style>${CSS}
  </style>
</head>
<body>
  <header class="mast">
    <h1>agent-relay</h1>
    <div class="brand">private chat links</div>
  </header>
  <main>
    ${bodyHtml}
  </main>
  <footer>Links are private to whoever holds them. Chats expire after 30 days without a message.</footer>
</body>
</html>`;
}

export function renderLanding({ origin = "", error = null } = {}) {
  const errorHtml = error
    ? `<p class="banner error" data-testid="error" role="alert">${escapeHtml(error)}</p>`
    : "";
  const body = `
    <p class="label">private chat links</p>
    <h2 class="title">Make a link. Send it. Start talking.</h2>
    ${errorHtml}
    <div class="panel">
      <p class="label">how it works</p>
      <ol class="steps">
        <li><strong>Make a chat link</strong> below and give it a name.</li>
        <li><strong>Send the link</strong> to your buddy by text or email. They open it, pick a name, and you are talking.</li>
        <li><strong>No accounts, no app to install.</strong> Messages appear live for everyone in the chat.</li>
      </ol>
      <p class="hint">Anyone with the link can read and write, so share it like you would a private photo album. Chats expire after 30 days without a message.</p>
    </div>
    <form method="post" action="/" class="panel" data-testid="claim-form">
      <input type="hidden" name="action" value="claim">
      <p class="label">make your chat link</p>
      <label for="title">Chat name (optional)</label>
      <input id="title" name="title" maxlength="120" placeholder="e.g. Russ and Sam">
      <button type="submit">Create chat link</button>
    </form>
    <p class="hint">Connecting an AI agent instead? The API is documented in the repo. Agents can also join any chat with its read and write keys.</p>
  `;
  return shell("agent-relay", body);
}

export function renderCreated({
  origin = "",
  boxId,
  readKey,
  writeKey,
  title = "",
  shareUrl,
}) {
  const safeId = escapeHtml(boxId);
  const fullShare = `${origin}${shareUrl}`;
  const chatUrl = `${origin}/c/${encodeURIComponent(boxId)}`;
  const snippet = [
    `Chat "${boxId}" on agent-relay.`,
    `Share link (for humans): ${fullShare}`,
    `Read key: ${readKey}`,
    `Write key: ${writeKey}`,
    ``,
    `Send: POST /v1/boxes/${boxId}/messages with header "Authorization: Bearer <write_key>"`,
    `  and JSON {sender, body, client_msg_id, recipient?, reply_to?}`,
    `Wait for replies without polling: GET /v1/boxes/${boxId}/messages?since=<cursor>&wait=25`,
    `  with header "Authorization: Bearer <read_key>". The request holds up to`,
    `  25 seconds and returns the moment a message lands.`,
  ].join("\n");
  const body = `
    <p class="banner ok" data-testid="created" role="status">Chat link created. Send it to your buddy.</p>
    <div class="panel">
      <p class="label">your chat link</p>
      <h2 class="title" data-testid="box-id">${title ? escapeHtml(title) : safeId}</h2>
      <div class="sharebox">
        <input id="share-link" readonly value="${escapeHtml(fullShare)}" data-testid="share-url"
               aria-label="Chat link" onclick="this.select()">
        <button type="button" id="copy-btn">Copy</button>
      </div>
      <p class="hint">Text or email this link to your buddy. They open it, pick a name, and you are talking. The secret part lives after the <code>#</code>, so it never shows up in server logs.</p>
      <p><a href="${escapeHtml(fullShare)}">Open the chat yourself</a></p>
    </div>
    <div class="panel">
      <p class="label">paste this into your agent</p>
      <pre class="snippet" data-testid="agent-snippet">${escapeHtml(snippet)}</pre>
    </div>
    <details class="owner">
      <summary>Owner controls and API keys</summary>
      <div class="panel">
        <div class="keyrow"><span>Read key</span><code data-testid="read-key">${escapeHtml(readKey)}</code></div>
        <div class="keyrow"><span>Write key</span><code data-testid="write-key">${escapeHtml(writeKey)}</code></div>
        <p class="hint">Keys are shown only once. Save them if an agent will join this chat.</p>
        <form method="post" action="/owner/rotate">
          <input type="hidden" name="box_id" value="${safeId}">
          <input type="hidden" name="read_key" value="${escapeHtml(readKey)}">
          <input type="hidden" name="write_key" value="${escapeHtml(writeKey)}">
          <input type="hidden" name="title" value="${escapeHtml(title)}">
          <button type="submit" class="ghost">Get a new invite link</button>
          <p class="hint">The old link stops working immediately. Use this if a link leaks.</p>
        </form>
        <form method="post" action="/owner/delete" onsubmit="return confirm('Delete this chat forever?');">
          <input type="hidden" name="box_id" value="${safeId}">
          <input type="hidden" name="write_key" value="${escapeHtml(writeKey)}">
          <button type="submit" class="danger">Delete this chat</button>
        </form>
      </div>
    </details>
    <p><a href="/">Make another chat link</a></p>
    <script>
      document.getElementById("copy-btn").addEventListener("click", function () {
        var el = document.getElementById("share-link");
        el.select();
        var done = function (ok) {
          var btn = document.getElementById("copy-btn");
          btn.textContent = ok ? "Copied" : "Copy";
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(el.value).then(function () { done(true); }, function () { done(false); });
        } else {
          try { done(document.execCommand("copy")); } catch (e) { done(false); }
        }
      });
    </script>
  `;
  return shell(`chat ${boxId} created`, body);
}

export function renderDeleted({ boxId }) {
  const body = `
    <p class="banner ok" role="status">Chat <strong>${escapeHtml(boxId)}</strong> was deleted. Its link no longer works.</p>
    <p><a href="/">Make a new chat link</a></p>
  `;
  return shell("chat deleted", body);
}
