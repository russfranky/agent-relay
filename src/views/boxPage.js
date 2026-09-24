import { renderBoxPage as renderInner, agentSnippet } from "./box.html.js";
export { escapeHtml } from "./escape.js";
export { agentSnippet };

/** Adapter so routes can pass `{ unlocked }` or `{ locked }`. */
export function renderBoxPage(opts = {}) {
  const unlocked = opts.unlocked ?? (opts.locked === false);
  const messages = opts.messages || [];
  const oldestId =
    opts.oldestId ?? (messages.length ? messages[0].id : null);
  return renderInner({
    boxId: opts.boxId,
    title: opts.title || null,
    messages,
    locked: !unlocked,
    error: opts.error || null,
    expired: Boolean(opts.expired),
    origin: opts.origin || "",
    nextSince: opts.nextSince || 0,
    oldestId,
    readKeyForForm: opts.readKeyForForm || "",
  });
}
