import { readFileSync } from "node:fs";
import { escapeHtml } from "./escape.js";

const CLIENT_JS = readFileSync(new URL("./chat-client.js", import.meta.url), "utf8");

const CSS = `
    :root {
      --paper: #f3ead8;
      --ink: #1c1812;
      --muted: #6b6256;
      --rule: #d4c6a8;
      --card: #faf6ec;
      --mine: #2f4a34;
      --live: #2e7d32;
      --warn: #b7791f;
      --bad: #8b2e2e;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: var(--paper); color: var(--ink); }
    body {
      font-family: "Source Serif 4", "Iowan Old Style", Palatino, Georgia, serif;
      line-height: 1.45;
      min-height: 100dvh;
      display: flex;
      flex-direction: column;
    }
    header.mast {
      border-bottom: 2px solid var(--ink);
      padding: 0.7rem 1rem;
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 0.75rem;
      flex: 0 0 auto;
    }
    header.mast h1 { font-size: 1rem; letter-spacing: 0.02em; margin: 0; white-space: nowrap; }
    header.mast .brand {
      font-size: 0.85rem; color: var(--muted);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    main.chat-wrap {
      flex: 1 1 auto;
      display: flex;
      flex-direction: column;
      max-width: 44rem;
      width: 100%;
      margin: 0 auto;
      padding: 0.75rem 0.75rem 0;
      min-height: 0;
    }
    #status {
      display: flex; align-items: center; gap: 0.4rem;
      font-size: 0.8rem; color: var(--muted);
      padding: 0 0.25rem 0.5rem;
      flex: 0 0 auto;
    }
    .dot { width: 0.55rem; height: 0.55rem; border-radius: 50%; background: var(--warn); display: inline-block; }
    .dot.live { background: var(--live); }
    .dot.connecting { background: var(--warn); }
    .dot.reconnecting { background: var(--warn); }
    #messages {
      flex: 1 1 auto;
      overflow-y: auto;
      min-height: 12rem;
      padding: 0.25rem 0.25rem 0.75rem;
      display: flex;
      flex-direction: column;
      gap: 0.55rem;
    }
    #chat { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
    #chat[hidden] { display: none; }
    .msg { max-width: 85%; align-self: flex-start; }
    .msg.mine { align-self: flex-end; }
    .who { font-size: 0.75rem; color: var(--muted); margin: 0 0.1rem 0.15rem; }
    .bubble {
      background: var(--card);
      border: 1px solid var(--rule);
      border-radius: 0.9rem;
      padding: 0.5rem 0.75rem;
      font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      font-size: 0.95rem;
      overflow-wrap: break-word;
      white-space: pre-wrap;
    }
    .msg.mine .bubble { background: var(--mine); border-color: var(--mine); color: #f5f1e6; }
    .when { font-size: 0.7rem; color: var(--muted); margin: 0.15rem 0.25rem 0; }
    .msg.mine .when { text-align: right; }
    #composer {
      flex: 0 0 auto;
      display: flex;
      gap: 0.5rem;
      padding: 0.6rem 0 calc(0.75rem + env(safe-area-inset-bottom));
      border-top: 1px solid var(--rule);
      background: var(--paper);
      position: sticky;
      bottom: 0;
    }
    #composer input {
      flex: 1 1 auto;
      font: inherit;
      font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      font-size: 1rem;
      border: 1px solid var(--ink);
      border-radius: 1.4rem;
      background: #fff;
      padding: 0.55rem 0.9rem;
      min-width: 0;
    }
    #composer button {
      font: inherit;
      background: var(--ink);
      color: var(--paper);
      border: 0;
      border-radius: 1.4rem;
      padding: 0.55rem 1.1rem;
      cursor: pointer;
      flex: 0 0 auto;
    }
    .panel {
      background: var(--card);
      border: 1px solid var(--ink);
      padding: 1.25rem;
      margin: 2rem auto;
      max-width: 26rem;
      width: 100%;
    }
    .panel h2 { margin: 0 0 0.5rem; font-size: 1.25rem; }
    .panel p { margin: 0.5rem 0; }
    .panel label { display: block; font-size: 0.85rem; margin: 0.6rem 0 0.2rem; }
    .panel input {
      width: 100%; font: inherit; font-size: 1rem;
      border: 1px solid var(--ink); background: #fff; padding: 0.5rem 0.6rem;
    }
    .panel button {
      font: inherit; background: var(--ink); color: var(--paper);
      border: 0; padding: 0.55rem 1rem; cursor: pointer; margin-top: 0.75rem; width: 100%;
    }
    .banner {
      padding: 0.75rem 0.9rem; border: 1px solid var(--bad); color: var(--bad);
      margin: 2rem auto; max-width: 26rem;
    }
    .hint { color: var(--muted); font-size: 0.85rem; }
    footer { color: var(--muted); font-size: 0.78rem; padding: 1rem; text-align: center; flex: 0 0 auto; }
`;

export function renderChatPage({ boxId }) {
  const safeId = escapeHtml(boxId);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>chat · ${safeId} · agent-relay</title>
  <style>${CSS}
  </style>
</head>
<body data-box-id="${safeId}">
  <header class="mast">
    <h1>agent-relay</h1>
    <div class="brand" id="chat-title">loading…</div>
  </header>
  <main class="chat-wrap">
    <div class="banner" id="link-error" hidden role="alert">
      This invite link is incomplete. Ask the person who invited you to send the
      <strong>full</strong> link, the part after the <code>#</code> matters.
    </div>
    <div class="panel" id="gate" hidden>
      <h2>Join the chat</h2>
      <p class="hint">Pick the name everyone will see. It is saved on this device only.</p>
      <form id="name-form">
        <label for="name">Your name</label>
        <input id="name" name="name" maxlength="40" required autocomplete="nickname"
               placeholder="e.g. Russ">
        <button type="submit">Join</button>
      </form>
    </div>
    <div id="chat" hidden>
      <div id="status" role="status"><span class="dot connecting" id="status-dot"></span><span id="status-text">Connecting…</span></div>
      <div id="messages" aria-live="polite"></div>
      <form id="composer">
        <input id="msg-input" maxlength="65536" autocomplete="off"
               placeholder="Message…" aria-label="Message">
        <button type="submit">Send</button>
      </form>
    </div>
    <div class="banner" id="fatal" hidden role="alert"></div>
    <noscript><div class="banner" role="alert">This chat needs JavaScript to stay live.</div></noscript>
  </main>
  <footer>Messages are private to this link. Anyone with the link can read and write.</footer>
  <script>${CLIENT_JS}</script>
</body>
</html>`;
}
