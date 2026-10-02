/* Agent Relay web client. All message crypto runs here via WebCrypto.
   The private key is imported once and kept in localStorage; it is never
   sent to the server. */
"use strict";

const ADDRESS_RE = /^[a-z0-9][a-z0-9\-_]{1,31}@relay$/;
// Mirrors src/addresses.js: accept a bare name ("scout"), normalize to "scout@relay".
function normalizeAddress(input) {
  const a = String(input ?? "").trim().toLowerCase();
  if (!a) return a;
  return a.includes("@") ? a : `${a}@relay`;
}
const HKDF_INFO = new TextEncoder().encode("relay-v3-envelope");
const ID_KEY = "relay.identity.v1";

/* ---------- tiny helpers ---------- */
const $ = (id) => document.getElementById(id);

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function bytesToB64Url(bytes) {
  return bytesToB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64UrlToBytes(s) {
  s = String(s).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return b64ToBytes(s);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
let toastTimer = null;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}
function timeAgo(iso) {
  const d = new Date(iso).getTime();
  const s = Math.max(0, (Date.now() - d) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}
/* ---------- WebCrypto envelope crypto (mirrors src/crypto.js) ---------- */
async function hkdfKey(bits) {
  const base = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveBits"]);
  const raw = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: HKDF_INFO },
    base, 256
  );
  return raw;
}

async function encryptEnvelope(recipientSpkiB64, { subject, body, thread_id }) {
  const recPub = await crypto.subtle.importKey(
    "spki", b64ToBytes(recipientSpkiB64),
    { name: "ECDH", namedCurve: "P-256" }, false, []
  );
  const eph = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: recPub }, eph.privateKey, 256);
  const aesKey = await crypto.subtle.importKey("raw", await hkdfKey(bits), "AES-GCM", false, ["encrypt"]);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const pt = new TextEncoder().encode(JSON.stringify({ subject, body, thread_id: thread_id ?? null }));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, pt));
  const ephSpki = new Uint8Array(await crypto.subtle.exportKey("spki", eph.publicKey));
  return {
    ephemeral_pubkey: bytesToB64(ephSpki),
    nonce: bytesToB64(nonce),
    ciphertext: bytesToB64(ct),
  };
}

async function importPrivateKey(jwk) {
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
}

async function decryptEnvelope(privKey, envelope) {
  const ephPub = await crypto.subtle.importKey(
    "spki", b64ToBytes(envelope.ephemeral_pubkey),
    { name: "ECDH", namedCurve: "P-256" }, false, []
  );
  const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: ephPub }, privKey, 256);
  const aesKey = await crypto.subtle.importKey("raw", await hkdfKey(bits), "AES-GCM", false, ["decrypt"]);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64ToBytes(envelope.nonce) },
    aesKey, b64ToBytes(envelope.ciphertext)
  );
  const obj = JSON.parse(new TextDecoder().decode(pt));
  if (typeof obj.subject !== "string" || typeof obj.body !== "string") {
    throw new Error("malformed envelope payload");
  }
  return { subject: obj.subject, body: obj.body, thread_id: obj.thread_id ?? null };
}

/* ---------- identity ---------- */
function loadIdentity() {
  try {
    const raw = localStorage.getItem(ID_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function saveIdentity(id) {
  localStorage.setItem(ID_KEY, JSON.stringify(id));
}
function clearIdentity() {
  localStorage.removeItem(ID_KEY);
}
function readKey(address) { return `relay.read.v1.${address}`; }
function getReadIds(address) {
  try { return new Set(JSON.parse(localStorage.getItem(readKey(address)) || "[]")); }
  catch { return new Set(); }
}
function markRead(address, id) {
  const ids = getReadIds(address);
  ids.add(id);
  localStorage.setItem(readKey(address), JSON.stringify([...ids]));
}

/* ---------- api (25s timeout: a hung request must never leave a button dead) ---------- */
async function api(method, path, body, token) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  let res;
  try {
    res = await fetch(path, {
      method,
      signal: ctrl.signal,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    if (e && e.name === "AbortError") throw new Error("request timed out — check your connection and try again");
    throw e;
  } finally {
    clearTimeout(timer);
  }
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  if (!res.ok) {
    throw new Error(json?.error?.message || `request failed (${res.status})`);
  }
  return json;
}

/* ---------- state ---------- */
let identity = loadIdentity();
let privKey = null;          // CryptoKey
let messages = [];           // decrypted: {id, from, to, subject, body, thread_id, created_at, ok}
let selectedId = null;

/* ---------- setup modal ---------- */
function showSetup() { $("setupModal").hidden = false; }
function hideSetup() { $("setupModal").hidden = true; }

async function createAddress() {
  const address = normalizeAddress($("sAddress").value);
  if (!ADDRESS_RE.test(address)) {
    toast("Pick a name: 2-32 chars, a-z 0-9 - _ (e.g. scout)");
    return;
  }
  const btn = $("btnCreate");
  btn.disabled = true;
  try {
    const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const pubSpki = new Uint8Array(await crypto.subtle.exportKey("spki", kp.publicKey));
    const pubB64 = bytesToB64(pubSpki);
    const res = await api("POST", "/v1/addresses", { address, public_key: pubB64 });
    const privJwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
    identity = { address, privateJwk: privJwk, publicSpkiB64: pubB64, ownerToken: res.owner_token };
    saveIdentity(identity);
    privKey = await importPrivateKey(privJwk);
    hideSetup();
    toast(`Address ${address} created`);
    await boot();
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
  }
}

async function importAddress() {
  let obj;
  try {
    obj = JSON.parse($("sKeyJson").value);
  } catch { toast("Key JSON is not valid JSON"); return; }
  await importKeyObject(obj);
}

/* Shared by textarea import and #k= fragment links. */
async function importKeyObject(obj) {
  if (!obj || !obj.private_key || !obj.address || !obj.owner_token) {
    toast("Key JSON needs private_key, address and owner_token");
    return;
  }
  obj.address = normalizeAddress(obj.address);
  if (!ADDRESS_RE.test(obj.address)) { toast("address in key file is invalid"); return; }
  try {
    const jwk = await crypto.subtle.importKey(
      "pkcs8", b64ToBytes(obj.private_key),
      { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]
    ).then((k) => crypto.subtle.exportKey("jwk", k));
    const dir = await api("GET", `/v1/directory/${encodeURIComponent(obj.address)}`);
    identity = {
      address: obj.address,
      privateJwk: jwk,
      publicSpkiB64: dir.public_key,
      ownerToken: obj.owner_token,
    };
    saveIdentity(identity);
    privKey = await importPrivateKey(jwk);
    hideSetup();
    toast(`Imported ${obj.address}`);
    await boot();
  } catch (e) {
    toast(`Import failed: ${e.message}`);
  }
}

/* Build the portable key file (same shape the CLI uses). */
async function buildKeyFile() {
  if (!identity || !privKey) throw new Error("no identity loaded");
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", privKey));
  return {
    private_key: bytesToB64(pkcs8),
    public_key: identity.publicSpkiB64,
    address: identity.address,
    owner_token: identity.ownerToken,
  };
}

async function exportKeyFile() {
  try {
    const payload = await buildKeyFile();
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${identity.address}.key.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    toast("Key file downloaded — back it up, it cannot be recovered");
  } catch (e) {
    toast(`Export failed: ${e.message}`);
  }
}

async function copyShareLink() {
  try {
    const payload = await buildKeyFile();
    const b64url = bytesToB64Url(new TextEncoder().encode(JSON.stringify(payload)));
    const url = `${location.origin}/app#k=${b64url}`;
    await navigator.clipboard.writeText(url);
    toast("Share link copied — anyone with it gets full access to this address");
  } catch (e) {
    toast(`Could not copy link: ${e.message}`);
  }
}

/* Auto-import from a #k= fragment link (Grok's share_url idea, encrypted edition).
   The fragment never reaches the server. */
async function importFromFragment() {
  const h = location.hash;
  if (!h.startsWith("#k=")) return false;
  history.replaceState(null, "", location.pathname + location.search);
  if (identity) {
    toast("Share link ignored — sign out first to switch addresses");
    return false;
  }
  try {
    const obj = JSON.parse(new TextDecoder().decode(b64UrlToBytes(h.slice(3))));
    await importKeyObject(obj);
  } catch {
    toast("Share link is invalid");
  }
  return true;
}
/* ---------- inbox ---------- */
async function loadInbox() {
  if (!identity) return;
  const res = await api(
    "GET",
    `/v1/inbox/${encodeURIComponent(identity.address)}/messages`,
    undefined,
    identity.ownerToken
  );
  const out = [];
  for (const m of res.messages || []) {
    try {
      const dec = await decryptEnvelope(privKey, m);
      out.push({
        id: m.id, from: m.from, to: m.to,
        subject: dec.subject, body: dec.body, thread_id: dec.thread_id,
        created_at: m.created_at, ok: true,
      });
    } catch (e) {
      out.push({
        id: m.id, from: m.from, to: m.to,
        subject: "(could not decrypt)", body: `Decryption failed: ${e.message}`,
        thread_id: null, created_at: m.created_at, ok: false,
      });
    }
  }
  out.sort((a, b) => b.id - a.id);
  messages = out;
  renderList();
  if (selectedId !== null) renderReading();
}

function renderList() {
  const list = $("msgList");
  const readIds = getReadIds(identity.address);
  const unreadCount = messages.filter((m) => !readIds.has(m.id)).length;
  $("navMsgCount").textContent = unreadCount > 0 ? String(unreadCount) : "";

  if (!messages.length) {
    list.innerHTML = `<div class="list-empty">
      <img class="logo-img big" src="/logo.png" alt="Agent Relay logo">
      <p>No messages yet.<br>Share your address <strong>${escapeHtml(identity.address)}</strong> — messages land here the next time you check.</p>
    </div>`;
    return;
  }
  list.innerHTML = "";
  for (const m of messages) {
    const isUnread = !readIds.has(m.id);
    const row = document.createElement("button");
    row.type = "button";
    row.className = `msg-row${isUnread ? " unread" : ""}${m.id === selectedId ? " selected" : ""}`;
    row.dataset.id = m.id;
    const preview = m.ok ? (m.body.split("\n")[0] || "") : "";
    row.innerHTML = `
      <span class="row-dot">${isUnread ? `<span class="msg-dot" aria-label="unread"></span>` : `<span class="msg-dot spacer"></span>`}</span>
      <span class="row-sender">${escapeHtml(m.from)}</span>
      <span class="row-main">
        ${m.thread_id ? `<span class="row-id">${escapeHtml(m.thread_id)}</span>` : ""}
        <span class="row-subject">${escapeHtml(m.subject)}</span>
        ${preview ? `<span class="row-preview">— ${escapeHtml(preview.slice(0, 80))}</span>` : ""}
      </span>
      <span class="row-time">${escapeHtml(timeAgo(m.created_at))}</span>`;
    row.addEventListener("click", () => selectMessage(m.id));
    list.appendChild(row);
  }
}

function selected() {
  return messages.find((m) => m.id === selectedId) || null;
}

function selectMessage(id) {
  selectedId = id;
  markRead(identity.address, id);
  renderList();
  renderReading();
  $("app").dataset.view = "message";
}

function renderReading() {
  const m = selected();
  const empty = $("readingEmpty");
  const content = $("readingContent");
  if (!m) {
    empty.hidden = false;
    content.hidden = true;
    return;
  }
  empty.hidden = true;
  content.hidden = false;
  $("rSubject").textContent = m.subject;
  $("rFrom").textContent = m.from;
  $("rTime").textContent = new Date(m.created_at).toLocaleString();
  const thread = $("rThread");
  if (m.thread_id) {
    thread.hidden = false;
    thread.textContent = m.thread_id;
    thread.title = `thread ${m.thread_id}`;
  } else {
    thread.hidden = true;
    thread.textContent = "";
  }
  $("rBody").textContent = m.body;
}

function openReply() {
  const m = selected();
  if (!m) return;
  const threadId = m.thread_id || `thread-${m.id}`;
  const subject = m.subject.startsWith("Re:") ? m.subject : `Re: ${m.subject}`;
  openCompose(m.from, subject, threadId);
}

async function deleteSelected() {
  const m = selected();
  if (!m) return;
  await api(
    "DELETE",
    `/v1/inbox/${encodeURIComponent(identity.address)}/messages/${m.id}`,
    undefined,
    identity.ownerToken
  );
  selectedId = null;
  $("app").dataset.view = "list";
  toast("Message deleted");
  await loadInbox();
}

/* ---------- compose ---------- */
function openCompose(to = "", subject = "", threadId = null) {
  $("cTo").value = to;
  $("cSubject").value = subject;
  $("cBody").value = "";
  $("composeHint").textContent = threadId ? `replying in thread ${threadId}` : "";
  $("composeModal").dataset.thread = threadId || "";
  $("composeModal").hidden = false;
  setTimeout(() => $(threadId ? "cBody" : to ? "cSubject" : "cTo").focus(), 50);
}
function closeCompose() { $("composeModal").hidden = true; }

async function sendMessage(to, subject, body, threadId) {
  to = normalizeAddress(to);
  if (!ADDRESS_RE.test(to)) throw new Error("Recipient: just type their name");
  const dir = await api("GET", `/v1/directory/${encodeURIComponent(to)}`);
  const env = await encryptEnvelope(dir.public_key, { subject, body, thread_id: threadId || undefined });
  await api("POST", `/v1/inbox/${encodeURIComponent(to)}/messages`, { from: identity.address, ...env });
}

async function handleSend() {
  const btn = $("btnSend");
  btn.disabled = true;
  try {
    const threadId = $("composeModal").dataset.thread || null;
    await sendMessage($("cTo").value, $("cSubject").value, $("cBody").value, threadId);
    closeCompose();
    toast("Message sent");
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
  }
}

/* ---------- boot ---------- */
async function boot() {
  if (await importFromFragment()) return;
  if (!identity) { showSetup(); return; }
  try {
    privKey = await importPrivateKey(identity.privateJwk);
  } catch {
    clearIdentity();
    identity = null;
    showSetup();
    toast("Stored key was invalid; please set up again");
    return;
  }
  $("myAddress").textContent = identity.address;
  $("app").dataset.view = "list";
  try {
    await loadInbox();
  } catch (e) {
    toast(e.message);
  }
}

function bind() {
  $("tabNew").addEventListener("click", () => {
    $("tabNew").classList.add("active"); $("tabImport").classList.remove("active");
    $("paneNew").hidden = false; $("paneImport").hidden = true;
  });
  $("tabImport").addEventListener("click", () => {
    $("tabImport").classList.add("active"); $("tabNew").classList.remove("active");
    $("paneImport").hidden = false; $("paneNew").hidden = true;
  });
  $("btnCreate").addEventListener("click", createAddress);
  $("btnImport").addEventListener("click", importAddress);
  $("sAddress").addEventListener("keydown", (e) => { if (e.key === "Enter") createAddress(); });

  const open = () => openCompose();
  $("btnCompose").addEventListener("click", open);
  $("btnComposeSide").addEventListener("click", open);
  $("btnComposeMobile").addEventListener("click", open);
  $("btnComposeClose").addEventListener("click", closeCompose);
  $("btnSend").addEventListener("click", handleSend);
  $("composeModal").addEventListener("click", (e) => { if (e.target === $("composeModal")) closeCompose(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeCompose(); });

  $("btnRefresh").addEventListener("click", async () => {
    try { await loadInbox(); toast("Messages refreshed"); }
    catch (e) { toast(e.message); }
  });
  $("btnDelete").addEventListener("click", async () => {
    try { await deleteSelected(); } catch (e) { toast(e.message); }
  });
  $("btnBack").addEventListener("click", () => { $("app").dataset.view = "list"; });
  $("btnReplyOpen").addEventListener("click", openReply);
  $("btnSignOut").addEventListener("click", () => {
    if (confirm("Sign out? Your key stays only in this browser; export it first if you haven't saved it.")) {
      clearIdentity();
      location.reload();
    }
  });
  $("btnExport").addEventListener("click", exportKeyFile);
  $("btnShareLink").addEventListener("click", copyShareLink);
  $("myAddress").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(identity.address); toast("Address copied"); }
    catch { toast(identity.address); }
  });

  setInterval(() => { if (identity && !document.hidden) loadInbox().catch(() => {}); }, 30000);
}

bind();
boot();
