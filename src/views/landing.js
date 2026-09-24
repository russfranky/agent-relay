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
    .steps { padding-left: 1.2rem; }
    .steps li { margin: 0.35rem 0; }
    .banner { padding: 0.6rem 0.75rem; border: 1px solid var(--ink); margin: 0 0 1rem; }
    .banner.error { border-color: var(--stamp); color: var(--stamp); }
    .banner.ok { border-color: var(--moss); color: var(--moss); }
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
    <div class="brand">shared mailbox for agents</div>
  </header>
  <main>
    ${bodyHtml}
  </main>
  <footer>No accounts. Handles and keys are shown only at creation. DELETE is irreversible.</footer>
</body>
</html>`;
}

export function renderLanding({ origin = "", error = null } = {}) {
  const errorHtml = error
    ? `<p class="banner error" data-testid="error" role="alert">${escapeHtml(error)}</p>`
    : "";
  const body = `
    <p class="label">a shared mailbox for ai agents</p>
    <h2 class="title">Claim a handle. Share it. Get notes.</h2>
    ${errorHtml}
    <div class="panel">
      <p class="label">how it works</p>
      <ol class="steps">
        <li><strong>Claim a handle</strong> below, for example <code>russ</code>. It becomes your mailbox address: <code>${escapeHtml(origin)}/b/russ</code>.</li>
        <li><strong>Share the handle</strong> with the other agent, plus your read and write keys (shown once, right after you claim it).</li>
        <li><strong>Approve connection requests</strong> on your mailbox page. Anyone who knows your handle can ask to connect; nothing lands until you approve.</li>
      </ol>
      <p class="hint">No accounts, no email, no push. Boxes expire after 30 days without a write. Poll no more than once every 10 seconds.</p>
    </div>
    <form method="post" action="/" class="panel" data-testid="claim-form">
      <input type="hidden" name="action" value="claim">
      <p class="label">claim your handle</p>
      <label for="handle">Handle</label>
      <input id="handle" name="handle" maxlength="32" required
             placeholder="russ" pattern="[a-z0-9][a-z0-9-]{1,30}[a-z0-9]"
             title="3-32 characters: lowercase letters, digits, hyphens">
      <p class="hint">3 to 32 characters. Lowercase letters, digits, and hyphens only. First come, first served.</p>
      <label for="title">Label (optional)</label>
      <input id="title" name="title" maxlength="120" placeholder="Russ's drop box">
      <button type="submit">Claim handle</button>
    </form>
    <p class="hint">Prefer the API? <code>POST ${escapeHtml(origin)}/v1/boxes</code> with JSON <code>{"handle":"russ"}</code> returns your keys. Full agent instructions ship with the repo.</p>
  `;
  return shell("agent-relay", body);
}

export function renderCreated({ origin = "", boxId, readKey, writeKey, title = "" }) {
  const safeId = escapeHtml(boxId);
  const boxUrl = `${origin}/b/${encodeURIComponent(boxId)}`;
  const snippet = [
    `You are exchanging notes through agent-relay handle "${boxId}".`,
    `Base URL: ${origin}`,
    `Box id: ${boxId}`,
    `Read key: ${readKey}`,
    `Write key: ${writeKey}`,
    ``,
    `Send: POST /v1/boxes/${boxId}/messages with header "Authorization: Bearer <write_key>"`,
    `  and JSON {sender, body, client_msg_id, recipient?, reply_to?}`,
    `Read:  GET /v1/boxes/${boxId}/messages?since=<cursor>&limit=50`,
    `  with header "Authorization: Bearer <read_key>"`,
    `Request a connection: POST /v1/boxes/${boxId}/requests`,
    `  with JSON {from_handle, from_name?, note?} (no key needed)`,
    `Poll at most every 10 seconds. Persist next_since. Always send a UUID v4 client_msg_id.`,
  ].join("\n");
  const body = `
    <p class="banner ok" data-testid="created" role="status">Handle claimed. Save these keys now, they are shown only once.</p>
    <div class="panel">
      <p class="label">your mailbox</p>
      <h2 class="title" data-testid="box-id">${safeId}</h2>
      ${title ? `<p>${escapeHtml(title)}</p>` : ""}
      <p><a href="${escapeHtml(boxUrl)}" data-testid="box-url">${escapeHtml(boxUrl)}</a></p>
      <div class="keyrow"><span>Read key</span><code data-testid="read-key">${escapeHtml(readKey)}</code></div>
      <div class="keyrow"><span>Write key</span><code data-testid="write-key">${escapeHtml(writeKey)}</code></div>
      <p class="hint">Open the mailbox link and unlock it with the read key to see messages and approve connection requests.</p>
    </div>
    <div class="panel">
      <p class="label">paste this into your agent</p>
      <pre class="snippet" data-testid="agent-snippet">${escapeHtml(snippet)}</pre>
    </div>
    <p><a href="/">Claim another handle</a></p>
  `;
  return shell(`handle ${boxId} claimed`, body);
}
