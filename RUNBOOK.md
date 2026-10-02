# Runbook: thatmgmt/relay — storage economics + suite foundation

## Goal (proposed criteria — provisional until Russ locks)

The relay stops accumulating unbounded storage; threads persist client-side.
Paid Jev service stays LATER (sketched, not built).

1. Server enforces a per-address storage bound (count cap + age TTL). Binary: test proves insert-beyond-cap evicts oldest and TTL sweep removes old rows.
2. CLI archives fetched messages to local disk (per-address JSONL) so threads survive outside the relay. Binary: fetch → archive file contains the decrypted thread.
3. Web app behavior unchanged under the bound (caps only, no delete-on-fetch). Binary: existing UI flows still pass.
4. Full suite green. Numeric: ≥ 36 tests passing (36 today).
5. Suite doc: thatmgmt/relay positioning + credits-ledger reuse plan written against ThatMgmt's actual payment primitives. Binary: doc exists and names the modules it reuses.

## Skeleton (unix: one thing per module, text interfaces)

| # | Module | One job | Interface |
|---|--------|---------|-----------|
| 1 | `relay-retention` | Bound server storage | Env: `RELAY_MAX_MSGS_PER_ADDRESS` (default 500), `RELAY_MSG_TTL_DAYS` (default 30). Enforce on insert (delete oldest past cap); lazy probabilistic TTL sweep. |
| 2 | `relay-archive` | Client-side thread persistence | `relay.js inbox --archive <dir>` appends fetched+decrypted messages to `<dir>/<address>.jsonl`. |
| 3 | `relay-ledger` | LATER: credits ledger for paid services | Reuses ThatMgmt Privy/Stripe primitives (map pending). Sketch only — not built in this pass. |
| 4 | `suite-doc` | thatmgmt/relay positioning | Doc: suite placement, what the relay reuses from ThatMgmt, what stays independent. |

## Sequence

1. `relay-retention` — no dependencies. Server-only, no client changes needed (caps, not delete-on-fetch).
2. `relay-archive` — independent; logically follows.
3. `relay-ledger` sketch — after ThatMgmt payments map lands.
4. `suite-doc` — last; describes what was built.

Explicit non-goals this pass: delete-on-fetch (needs client archive shipped first — later module), Drive/BYOS sync (later), jev@relay daemon (later), repo merge into ThatMgmt monorepo (decision for Russ).

## Checklist

- [x] M1: retention env vars + insert-cap enforcement in `src/server.js` (both adapters)
- [x] M1: TTL sweep (lazy, probabilistic — no new infra on serverless)
- [x] M1: tests (cap eviction, TTL expiry, defaults)
- [x] M1: `npm test` green (40/40), Jev output-verify auto-pass (P92), docs updated
- [x] M1: deployed (dpl_HdRmUeZ3WUXFpYj5YfvrivrjJ8LS), live-verified new tree serving
- [x] M2: CLI `--archive` flag, JSONL append, thread replay
- [x] M2: tests (3/3), full suite 43/43, Jev output-verify auto-pass (P92); pushed to repo (CLI-only change — server tree identical to live deploy, no redeploy)
## M3 sketch: relay-ledger (LATER — not built this pass)

CORRECTION (2026-10-02, verified by reading thatmgmt source): there is NO Stripe
card/bank integration in thatmgmt. No stripe npm package, no PaymentIntents /
Checkout / Stripe-webhook code anywhere. The word "stripe" appears only in
"Bridge (Stripe stablecoin rails)" — Bridge's USDC→ACH off-ramp API, which is
gated OFF by default. Card top-ups would need to be built from scratch.
What EXISTS and is reusable: Privy crypto top-ups (USDC on Base chain).

Reusable for credits (with extraction):
- `privy-deposit-sdk.ts` → `createPrivyDepositClient` (as-is): per-top-up deposit address
- `privy-webhooks.ts` → `handlePrivyWebhookRequest` (pattern): Svix verify → normalize → idempotent reconcile
- `privy-payments.ts` → `reconcilePrivyDeposit` (extract): deposit-observation → credit logic, drop the quote/cut/tenant coupling
- `privy-server.ts` → composition pattern (fail-closed creds, injected pool)
- `persistence/privy-payments-postgres.ts` → upsert pattern; NEW tables `credit_accounts`, `credit_topups`

New logic (nothing in thatmgmt does metering): per-call balance compare-and-decrement
keyed by the API key found in the decrypted message body. Integer micro-USDC
throughout ($0.005/call = 5,000 micro-USDC, exactly representable).

Not applicable: `privy-settlement.ts`, `bridge-client.ts` (fiat off-ramp — only if
the operator ever cashes out accumulated USDC).

- [ ] M3: ledger sketch from payments map (pending subagent)
- [ ] M4: suite-doc
- [ ] Final: full suite green, Jev verify, push repo, deploy, report
