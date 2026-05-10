# `apps/demo` — Nyx live devnet dApp

A self-contained Next.js (App Router) front-end that walks a connected
**Phantom** wallet through the full Nyx privacy stack on **Solana devnet**:

1. **Identity** — derive a darkpool master seed from a deterministic Phantom
   signature, prove `VALID_WALLET_CREATE` in the **browser** (snarkjs +
   `circuits/valid_wallet_create/circuit.{wasm,zkey}` served from `public/`).
2. **Private deposit + withdraw** — deposit shielded base/quote into the vault
   and later spend the note via a browser-generated `VALID_SPEND` Groth16
   proof. The Merkle witness is reconstructed from the on-chain `right_path`
   snapshot we capture at deposit time, so no off-chain indexer is needed.
3. **Trade on devnet** — register the wallet on-chain, airdrop test tokens,
   init + delegate an Ephemeral Rollup pending-order slot, deposit quote
   collateral, submit a bid on the **ER** (signed by the seed-derived trading
   key, not Phantom), then run a server-side counterparty + `run_batch` and
   commit the market back to L1.

> All circuits run entirely in the user's browser inside a dedicated Web
> Worker (`src/workers/prover.worker.ts`). The user's Phantom signature, seed,
> and trading secret never leave the browser except as a short-lived input
> to the demo's API routes — which exist purely to talk to admin/funder/TEE
> keypairs that a real user wouldn't possess.

---

## Required local state

The demo expects the same artefacts as the SDK's devnet integration tests:

| Path                             | Purpose                                                          |
| -------------------------------- | ---------------------------------------------------------------- |
| `.devnet/e2e-config.json`        | RPC URL, vault / matching-engine program ids, market PDA, mints. |
| `.devnet/keypairs/admin.json`    | Mint authority for the demo's base + quote test tokens.          |
| `.devnet/keypairs/tee_authority.json` | Attested TEE signing key — signs `lock_note` + `run_batch`. |
| `~/.config/solana/id.json`       | SOL funder for ATA creation, slot init, delegation, etc.         |

You also need the four circuit blobs in `apps/demo/public/circuits/`:

```
public/circuits/valid_wallet_create/circuit.wasm
public/circuits/valid_wallet_create/circuit.zkey
public/circuits/valid_spend/circuit.wasm
public/circuits/valid_spend/circuit.zkey
```

These are checked in for convenience; regenerate them with
`scripts/build-circuits.sh` when the circom sources change.

---

## Environment variables

Drop a `.env.local` in `apps/demo/` with at least:

```ini
# Required — base58 secret (32-byte seed or 64-byte secret) for the maker persona
DEMO_MAKER_SECRET_BASE58=<base58>

# Optional — overrides for keypair paths
DEMO_ADMIN_KEYPAIR_PATH=.devnet/keypairs/admin.json
DEMO_TEE_KEYPAIR_PATH=.devnet/keypairs/tee_authority.json
DEMO_FUNDER_KEYPAIR_PATH=~/.config/solana/id.json

# Optional — RPC URLs (default to whatever .devnet/e2e-config.json holds)
DEMO_L1_RPC_URL=https://api.devnet.solana.com
DEMO_ER_RPC_URL=https://devnet.magicblock.app

# Optional — airdrop sizes (raw token base units)
DEMO_USER_AIRDROP_BASE=1000000000
DEMO_USER_AIRDROP_QUOTE=1000000000
DEMO_COUNTERPARTY_MINT_UI=200000000000

# Optional — fixed exchange rate (1 BASE = N QUOTE).
# `setup-devnet` provisions a mock oracle with TWAP=100 and a 5% circuit
# breaker — keep the rate (and bid price_limit) inside [95, 105] or
# `run_batch` will trip the breaker and produce zero matches.
DEMO_EXCHANGE_QUOTE_PER_BASE=100

# ---- Public, browser-visible defaults ----
NEXT_PUBLIC_DEMO_ER_RPC_URL=https://devnet.magicblock.app
NEXT_PUBLIC_DEMO_EXCHANGE_QUOTE_PER_BASE=100
# Omit to default bid price_limit to the same value as QUOTE_PER_BASE (so
# amount×price_limit fits the quote note from step 4). Set higher only if
# you also increase the quote deposit accordingly, AND keep the value
# inside the mock-oracle's 5% circuit-breaker band [95, 105].
# NEXT_PUBLIC_DEMO_ORDER_PRICE=100
NEXT_PUBLIC_DEMO_PRIVATE_AMOUNT=10000
```

Anything `NEXT_PUBLIC_*` is bundled into the client; all other vars stay
server-side and are read inside `app/api/dapp/*` route handlers.

---

## Running

From the monorepo root:

```bash
# 1. Install once
npm install

# 2. (one-time) Generate the devnet config + keypairs
#    See packages/sdk/tests/devnet-setup.test.ts for the canonical recipe.

# 3. Run the dApp
cd apps/demo
npm run dev          # http://localhost:3000/dapp
```

In production mode:

```bash
cd apps/demo
npm run build && npm run start
```

The build runs the full TypeScript check across all routes, components, and
the prover worker.

---

## Recommended on-page flow

1. **Connect Phantom** (devnet cluster).
2. **Wallet identity panel** — sign the deterministic message, prove
   `VALID_WALLET_CREATE` in the worker. The 64-byte trading secret + Groth16
   proof bytes are stashed into `sessionStorage` under
   `nyx-dapp-session-v1`.
3. *(Optional)* **Private deposit / withdraw panel** — first run the
   trade-flow **airdrop** step to seed your ATAs, then deposit a shielded
   note and withdraw it. This panel exercises the full
   `deposit → VALID_SPEND in browser → withdraw` arc and is the simplest
   end-to-end privacy demo. It must run **before** any `submit_order` /
   `run_batch` so the user's note is still the latest leaf in the vault tree
   (the demo verifies this and returns a clean error otherwise).
4. **Trade panel** — five chained steps (BASE + QUOTE are auto-airdropped
   by the identity panel above, so this flow assumes funded ATAs):

   | Step | Cluster | What happens |
   | ---- | ------- | ------------ |
   | 1 · Register wallet     | L1 | Phantom signs `create_wallet` (browser-built proof). Idempotent — if the `WalletEntry` PDA already exists from a prior run the step is skipped. |
   | 2 · Init + delegate slot | L1 | Funder + trading-key sign `init_pending_order_slot` then `delegate_pending_order` to MagicBlock. |
   | 3 · Deposit collateral  | L1 | Phantom deposits the quote leg of the bid. |
   | 4 · Submit bid          | ER | **Trading key** (not Phantom) signs `submit_order` on the Ephemeral Rollup. |
   | 5 · Counterparty + `run_batch` | L1 + ER | Server flips a maker, deposits its leg, submits the opposite order, runs `run_batch`, undelegates the market, waits for L1 commit. |

   Need to top up tokens later? Re-run the identity panel ("Re-derive") —
   it triggers another `/api/dapp/airdrop` mint to your wallet.

Every confirmed signature is appended to the on-page receipt with an
explorer link.

---

## Architecture notes

- **No node-only code reaches the browser.** The SDK's pure-TS helpers
  (`noteCommitment`, `nullifier`, `formatGroth16ForOnChain`, etc.) are
  imported by both client and server. Anything that needs SOL signing,
  filesystem reads, or the maker persona is wrapped in an `app/api/dapp/*`
  route with `runtime = "nodejs"`.
- **The Web Worker is the only place snarkjs runs.** The main thread sends
  decimal-string circuit inputs + URLs to `/circuits/...` and gets back a
  raw `proof.json` object. Formatting into on-chain bytes happens on the
  main thread via `formatGroth16ForOnChain` from `@nyx/sdk`.
- **Phantom never sees the trading key.** `submit_order` lives on the ER
  and must be signed by the seed-derived trading key, so we surface the
  64-byte secret in the session and sign the raw transaction client-side.
  The seed itself is never persisted; it's re-derived from the Phantom
  signature on every API call (see `lib/dapp/phantom-verify.ts`).
- **Withdraw without an indexer.** The on-chain vault keeps only
  `right_path[0..20]` and a leaf-count, not the full tree. To produce an
  inclusion proof for the user's deposit note, `/api/dapp/private-deposit`
  snapshots `right_path` *before* the deposit lands and stashes it in the
  response. `/api/dapp/withdraw-prepare` reconstructs the witness from that
  snapshot using the same insertion math the on-chain `append_leaf` runs
  (see `lib/dapp/merkle-witness.ts`). It validates the resulting root
  against the live `vault_config.current_root` before returning, so any
  drift surfaces as a clean error rather than a silent proof failure.

---

## API surface (server)

All of these live under `app/api/dapp/` and run on the Node.js runtime:

| Route                          | Purpose                                                           |
| ------------------------------ | ----------------------------------------------------------------- |
| `derive-identity`              | Verify Phantom signature, derive seed, return identity + trading. |
| `register-wallet`              | Build `create_wallet` ix (browser sends via Phantom).             |
| `airdrop`                      | Admin mints base + quote into the user's ATAs.                    |
| `private-deposit`              | Build `createAssociatedTokenAccount` (idempotent) + shielded `deposit` ixs + capture `right_path` snapshot. |
| `withdraw-prepare`             | Reconstruct Merkle witness, return circuit inputs.                |
| `withdraw-finalize`            | Re-verify session, build the `withdraw` ix from the proof.        |
| `init-slot`                    | Init + delegate the user's pending-order slot on the ER.          |
| `deposit-prepare`              | Build a quote-collateral deposit ix for the trade flow.           |
| `build-submit-order`           | Build `submit_order` ix (browser signs with the trading key).     |
| `counter-and-match`            | Server-side maker mirror + `run_batch` + commit-back to L1.       |
| `prover-fixture`               | Returns the smoke-test circuit inputs used by the prover panel.   |

---

## Known limitations

- **Single-process leaf tracking.** `private-deposit` only handles the
  case where the user's note is the most recent leaf appended to the
  vault. Concurrent deposits or running the trade flow before withdrawing
  invalidate the snapshot — the route returns a 409 with a descriptive
  message instead of a corrupt witness.
- **Fill-note withdraw isn't wired yet.** After `run_batch` the user holds
  fill + change notes whose blindings are derivable from the seed, but the
  demo doesn't yet track their leaf indices through the ER → L1 commit
  path. Adding it requires either a server-side shadow tree fed by every
  ER+L1 mutation or an on-chain event indexer.
- **Private deposit amount is raw SPL units.** The `Amount` field is the same
  `u64` the vault passes to `transfer_checked` — not Phantom’s human-readable
  balance. If pre-flight fails with Token `insufficient funds`, lower the
  amount or mint more via the trade-flow airdrop. That is unrelated to Merkle
  resets or `devnet-setup` — those scripts wire programs and PDAs; they do
  not top up your personal ATAs.
- **Single demo session per server process.** All state is in-memory inside
  the Next.js server. Restart the dev server to reset.
