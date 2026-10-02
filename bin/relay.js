#!/usr/bin/env node
// agent-relay CLI (zero deps).
//   keygen    --out PATH            generate P-256 keypair (0600)
//   register  --address a@relay [--key PATH] [--url URL]
//   send      --to a@relay --subject S --body B [--from a@relay] [--thread T] [--key PATH] [--url URL]
//   inbox     [--key PATH] [--url URL] [--address a@relay] [--archive DIR]
//   read      --id N [--keep] [--key PATH] [--url URL]
//
// --archive DIR: append fetched+decrypted messages to DIR/<address>.jsonl
// (one JSON object per line). Ids already archived are skipped, so re-running
// is safe. The archive holds plaintext — keep it private; it is your thread
// history, independent of the relay's bounded server mailbox.
//
// Key file: ~/.relay/key.json by default, or RELAY_KEY env.
// Server: http://127.0.0.1:8787 by default, or RELAY_URL env.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateKeypair, encryptEnvelope, decryptEnvelope } from "../src/crypto.js";
import { normalizeAddress } from "../src/addresses.js";

const DEFAULT_URL = process.env.RELAY_URL || "http://127.0.0.1:8787";
const DEFAULT_KEY = process.env.RELAY_KEY || path.join(os.homedir(), ".relay", "key.json");

function usage(exitCode = 1) {
  console.error(`agent-relay CLI

  keygen    --out PATH            generate a P-256 keypair (file mode 0600)
  register  --address NAME [--key PATH] [--url URL]
  send      --to NAME --subject S --body B [--from NAME] [--thread T] [--key PATH] [--url URL]
  inbox     [--key PATH] [--url URL] [--address NAME] [--archive DIR]
  read      --id N [--keep] [--key PATH] [--url URL]

  --archive DIR appends fetched+decrypted messages to DIR/<address>.jsonl
  (one JSON object per line, duplicates skipped). Your thread history,
  independent of the relay's bounded server mailbox.

Type a bare name ("scout") or the full address ("scout@relay").

Key file defaults to $RELAY_KEY or ~/.relay/key.json. Server defaults to
$RELAY_URL or http://127.0.0.1:8787.`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function loadKeyFile(p) {
  const fp = p || DEFAULT_KEY;
  if (!fs.existsSync(fp)) {
    console.error(`key file not found: ${fp}\nrun: relay.js keygen --out ${fp}`);
    process.exit(1);
  }
  return { data: JSON.parse(fs.readFileSync(fp, "utf8")), path: fp };
}

function saveKeyFile(fp, data) {
  fs.mkdirSync(path.dirname(fp), { recursive: true, mode: 0o700 });
  fs.writeFileSync(fp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
}

async function api(url, method, p, body, token) {
  const res = await fetch(url + p, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch { /* non-JSON */ }
  if (!res.ok) {
    const msg = json?.error?.message || `HTTP ${res.status}`;
    console.error(`error: ${msg} (${json?.error?.code || res.status})`);
    process.exit(1);
  }
  return json;
}

function fmtTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString();
}

// Append decrypted messages to DIR/<address>.jsonl, one JSON object per line.
// Ids already present are skipped so repeated fetches never duplicate.
function archiveMessages(dir, address, items) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${address}.jsonl`);
  const seen = new Set();
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { seen.add(JSON.parse(line).id); } catch { /* ignore bad lines */ }
    }
  }
  const fresh = [];
  for (const m of items) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    fresh.push(JSON.stringify(m));
  }
  if (fresh.length) fs.appendFileSync(file, fresh.join("\n") + "\n");
  return { file, added: fresh.length };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  const url = args.url || DEFAULT_URL;

  if (cmd === "keygen") {
    const out = args.out || DEFAULT_KEY;
    if (fs.existsSync(out)) {
      console.error(`refusing to overwrite existing key file: ${out}`);
      process.exit(1);
    }
    const kp = generateKeypair();
    saveKeyFile(out, { private_key: kp.privateKeyPkcs8B64, public_key: kp.publicKeySpkiB64 });
    console.log(`wrote keypair to ${out} (mode 0600)`);
    console.log("WARNING: the private key never leaves this file. Back it up; it cannot be recovered.");
    return;
  }

  if (cmd === "register") {
    const address = normalizeAddress(args.address);
    if (!address) usage();
    const { data, path: fp } = loadKeyFile(args.key);
    const res = await api(url, "POST", "/v1/addresses", {
      address,
      public_key: data.public_key,
    });
    data.address = address;
    data.owner_token = res.owner_token;
    saveKeyFile(fp, data);
    console.log(`registered ${res.address}`);
    console.log(`owner token (shown ONCE, saved to ${fp}): ${res.owner_token}`);
    console.log("WARNING: anyone with this token can read and delete this mailbox. Keep it secret.");
    return;
  }

  if (cmd === "send") {
    const to = normalizeAddress(args.to);
    const subject = args.subject ?? "";
    const body = args.body ?? "";
    if (!to) usage();
    const { data } = loadKeyFile(args.key);
    const from = normalizeAddress(args.from || data.address);
    if (!from) {
      console.error("no --from given and key file has no registered address; register first");
      process.exit(1);
    }
    const dir = await api(url, "GET", `/v1/directory/${encodeURIComponent(to)}`);
    const env = encryptEnvelope(dir.public_key, { subject, body, thread_id: args.thread });
    const res = await api(url, "POST", `/v1/inbox/${encodeURIComponent(to)}/messages`, {
      from,
      ...env,
    });
    console.log(`sent to ${to} (id ${res.id})`);
    return;
  }

  if (cmd === "inbox" || cmd === "read") {
    const { data } = loadKeyFile(args.key);
    const address = normalizeAddress(args.address || data.address);
    const token = data.owner_token;
    if (!address || !token) {
      console.error("key file has no address/owner_token; register first");
      process.exit(1);
    }
    const res = await api(url, "GET", `/v1/inbox/${encodeURIComponent(address)}/messages`, undefined, token);
    const messages = res.messages || [];
    if (cmd === "inbox") {
      if (!messages.length) {
        console.log(`inbox ${address}: empty`);
        return;
      }
      const archived = [];
      for (const m of messages) {
        let dec;
        try {
          dec = decryptEnvelope(data.private_key, m);
        } catch (e) {
          dec = { subject: "(decrypt failed)", body: e.message, thread_id: null };
        }
        console.log(`--- id ${m.id} | from ${m.from} | ${fmtTime(m.created_at)} ---`);
        console.log(`subject: ${dec.subject}`);
        if (dec.thread_id) console.log(`thread: ${dec.thread_id}`);
        console.log(dec.body);
        console.log();
        archived.push({
          id: m.id, from: m.from, to: address,
          subject: dec.subject, body: dec.body, thread_id: dec.thread_id || null,
          created_at: m.created_at,
        });
      }
      const archiveDir = args.archive || process.env.RELAY_ARCHIVE_DIR;
      if (archiveDir) {
        const { file, added } = archiveMessages(archiveDir, address, archived);
        console.log(`archived ${added} new message(s) to ${file}`);
      }
      return;
    }
    // read --id
    const id = Number(args.id);
    if (!Number.isFinite(id)) usage();
    const m = messages.find((x) => x.id === id);
    if (!m) {
      console.error(`message ${id} not found in inbox`);
      process.exit(1);
    }
    const dec = decryptEnvelope(data.private_key, m);
    console.log(`--- id ${m.id} | from ${m.from} | ${fmtTime(m.created_at)} ---`);
    console.log(`subject: ${dec.subject}`);
    if (dec.thread_id) console.log(`thread: ${dec.thread_id}`);
    console.log(dec.body);
    if (!args.keep) {
      await api(url, "DELETE", `/v1/inbox/${encodeURIComponent(address)}/messages/${id}`, undefined, token);
      console.log(`(deleted message ${id})`);
    }
    return;
  }

  usage(args._.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`fatal: ${e.message}`);
  process.exit(1);
});
