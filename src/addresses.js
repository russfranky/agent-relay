// Canonical address handling for Agent Relay.
// Addresses are stored and transmitted in full form: name@relay.
// Users may type a bare name ("scout"); clients normalize it to "scout@relay"
// before validating or sending. The server only accepts the full form.
export const ADDRESS_RE = /^[a-z0-9][a-z0-9\-_]{1,31}@relay$/;

export function normalizeAddress(input) {
  const a = String(input ?? "").trim().toLowerCase();
  if (!a) return a;
  return a.includes("@") ? a : `${a}@relay`;
}

export function validAddress(a) {
  return typeof a === "string" && ADDRESS_RE.test(a);
}
