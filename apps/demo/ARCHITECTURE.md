# `apps/demo` — architecture, indexerless hacks, and what an indexer would change

This document is the long-form companion to `README.md`. It exists to explain
**how this dapp ended up shaped the way it is**, what was load-bearing during
the build, and — critically — every place we paid the "no indexer" tax. If
you're wiring up a real indexer service for Nyx, the second half of this
document is the implementation checklist.

> Audience: someone picking this up cold, or future-you in 6 months wondering
> "why on earth did `vault-leaf-history.ts` exist".

---

## 1 · Top-level shape

```
                  ┌────────────────────────────┐
                  │        Phantom wallet      │
                  │  (devnet cluster, browser) │
                  └─────────────┬──────────────┘
                                │ signMessage / signTransaction
                                ▼
   ┌─────────────────────────────────────────────────────────┐
   │                   Next.js client (RSC)                  │
   │  /dapp page                                             │
   │  ┌────────────────┐  ┌──────────────────┐               │
   │  │ wallet-identity│  │ private-deposit  │               │
   │  │ panel          │  │ /withdraw panel  │   etc.        │
   │  └────────────────┘  └──────────────────┘               │
   │                                                         │
   │  Web Worker (snarkjs)  ──>  VALID_WALLET_CREATE         │
   │                       ──>  VALID_SPEND                  │
   │                                                         │
   │  sessionStorage:                                        │
   │     nyx-dapp-session-v1   (seed-derived trading key)    │
   │     nyx-trade-withdraw    (post-trade BASE note hint)   │
   └────────────────────┬────────────────────────────────────┘
                        │ fetch /api/dapp/...
                        ▼
   ┌─────────────────────────────────────────────────────────┐
   │              Next.js API routes (Node runtime)          │
   │   - hold admin / TEE / funder / maker keypairs (DEMO)   │
   │   - re-verify Phantom signature on every call           │
   │   - build instructions, run server-side orchestration   │
   │   - never see the user's seed except as a derivation    │
   │     input from a fresh signature                        │
   └────────┬───────────────────────────────────┬────────────┘
            │                                   │
            ▼                                   ▼
   ┌──────────────────┐              ┌────────────────────────┐
   │ Solana L1        │              │ MagicBlock ER          │
   │  (devnet)        │              │  (delegated PDAs)      │
   │  - vault         │              │  - matching_engine     │
   │  - matching      │              │    (delegated state)   │
   │    engine        │              │                        │
   │  - DLP / oracle  │              │                        │
   └──────────────────┘              └────────────────────────┘
```

### 1.1 Trust model (demo, not production)

The Next.js server is the demo's "everyone-but-the-user". It holds:

- the **admin** keypair (mint authority for the demo's BASE/QUOTE tokens, and
  the only key allowed to call `set_protocol_config`),
- the **TEE authority** (signs `lock_note` and the canonical match payload
  for `tee_forced_settle`),
- the **funder** (rents PDAs, tops up SOL on derived keys),
- the **maker persona** (the "other side" of the user's order).

In production these would each live in their own service (TEE in an attested
enclave, admin in a multisig, maker in the customer's own bot, etc.). The
demo collapses them into one Next.js process for simplicity.

The user's Phantom wallet is the only thing the dapp **doesn't** control.
Every API route re-verifies the Phantom signature in `phantom-verify.ts` and
re-derives the seed from scratch — there is no session token, no server-side
seed cache, no authentication state.

### 1.2 The L1 / ER split

| Operation                        | Cluster | Why                                          |
| -------------------------------- | ------- | -------------------------------------------- |
| `create_wallet`, `deposit`       | L1      | Vault state lives on L1.                     |
| `init_pending_order_slot`        | L1      | PDA must exist on L1 first.                  |
| `delegate_pending_order`         | L1 → ER | MagicBlock delegation handoff.               |
| `submit_order`                   | ER      | Fast path — no L1 fee per order.             |
| `run_batch`                      | ER      | Matches in the rollup.                       |
| `undelegate_market`              | ER → L1 | Commits matched state back to L1.            |
| `lock_note` + `tee_forced_settle`| L1      | Vault settlement lives on L1 only.           |
| `withdraw`                       | L1      | Burn nullifier + push tokens to ATA on L1.   |

Once a `PendingOrder` slot is delegated, **L1 sees a stale snapshot**. Any
slot-status check has to re-read the account on the ER, not L1. This bites
hard in `chooseFreshSlot` (see §2.2).

### 1.3 ZK boundary

snarkjs runs **only inside a dedicated Web Worker** (`workers/prover.worker.ts`).
The main thread:

1. Builds decimal-string circuit inputs (no big-int wrangling in worker code).
2. Posts `{ circuit, inputs, wasmUrl, zkeyUrl }` to the worker.
3. Receives raw `proof.json` back.
4. Formats it via `@nyx/sdk`'s `formatGroth16ForOnChain` on the main thread.

Circuit blobs live under `public/circuits/` so the worker can fetch them by
URL. **No Anchor-style auto-formatting on the server** — every Groth16 byte
that goes on-chain was produced by the user's own browser.

### 1.4 Sessions

We use `sessionStorage` (not `localStorage`) for two pieces of state:

- `nyx-dapp-session-v1` — the seed-derived 64-byte trading secret + Phantom
  signature + owner commitment. Cleared on tab close, never persisted to
  disk. Used to sign `submit_order` on the ER (Phantom can't reach the ER).
- `nyx-trade-withdraw` — a hint object written by `counter-and-match` after
  L1 settle, telling the (currently-disabled) `TradeBaseWithdrawPanel` which
  leaf belongs to the user. Pure metadata; no key material.

Restart the tab → both go away. That's by design for a demo; a real product
would back these with an authenticated server-side store.

---

## 2 · The "no indexer" tax — every hack and where it lives

Each subsection below is a workaround we built **only because there's no
indexer service tracking program state for us**. Every one of these
disappears or shrinks dramatically once an indexer exists (see §3).

### 2.1 Reconstructing the vault Merkle tree from RPC history

**The problem.** The on-chain `VaultConfig` keeps:

- `current_root` (32 B),
- `roots[32]` ring buffer (most recent 32 historical roots),
- `right_path[20]` (just enough to append the *next* leaf),
- `leaf_count: u64`.

It does **not** store the leaves themselves, the full tree, or any per-leaf
metadata. To produce a `VALID_SPEND` inclusion witness for a leaf at index K,
we need every sibling on the path from K to the root — i.e., we need to know
*every leaf*.

**The hack.** `lib/dapp/vault-leaf-history.ts` walks the vault program's
transaction history via `getSignaturesForAddress` and rebuilds the leaves
in chronological order:

1. **Pagination.** `getSignaturesForAddress` is hard-capped at `limit=1000`.
   We page back with the `before` cursor (`fetchSignaturesPaginated`) until
   we've got enough or the chain ends.
2. **Per-tx parse.** For each signature, fetch the transaction, walk both
   top-level instructions and inner CPIs, identify vault `deposit` and
   `tee_forced_settle` calls by their Anchor discriminator, and extract the
   leaf commitments those instructions appended:
   - `deposit`: rebuild the leaf via `noteCommitment({ tokenMint, amount,
     ownerCommitment, nonce, blindingR })`. Crucially, `tokenMint` must be
     resolved from the *deposit instruction's own* `accountKeyIndexes[2]`,
     not the global `accountKeys[2]` — getting this wrong silently produces
     leaves with the wrong mint and a Merkle root that diverges from chain.
   - `tee_forced_settle`: parse the 448-byte payload and append `note_c`,
     `note_d`, then conditionally `note_e`, `note_f`, `note_fee` (matching
     the on-chain `append_leaf` order in `tee_forced_settle.rs`).
3. **Inner-CPI base58.** Top-level instruction `data` arrives as `Uint8Array`,
   but inner-CPI `data` arrives as a **base58 string** per `CompiledInstruction`
   in `@solana/web3.js/src/message/legacy.ts`. We use `bs58.decode`, not
   `Buffer.from(_, "base64")`, or vault leaves from CPI'd vault calls would
   silently fail the discriminator check and be skipped.
4. **MerkleShadow.** `lib/dapp/merkle-shadow.ts` is an in-process incremental
   tree that mirrors `programs/vault/src/merkle.rs::append_leaf` exactly,
   including `compute_zero_subtree_roots`. We append all replayed leaves and
   then call `witness(K)` to get siblings + the root.
5. **Ring-buffer fallback.** Even after all of this, `current_root` can have
   moved on by the time the witness API responds (devnet is shared). The
   on-chain `withdraw` accepts any of 33 roots (`current_root` ∪ `roots[32]`),
   so `trade-withdraw-prepare` walks **prefixes** of the leaf set from full
   length down toward `leafIndex+1` and accepts the first witness whose root
   is in the ring.

**Cost.** Several hundred lines of code (`vault-leaf-history.ts` ~260,
`merkle-shadow.ts` ~120, `merkle-witness.ts` ~80) plus per-witness latency
of "scan thousands of signatures, fetch each, parse, hash". On devnet's
shared vault account, replaying 200+ leaves takes 20–60 s of network time.

**File map:**
- `src/lib/dapp/vault-leaf-history.ts`
- `src/lib/dapp/merkle-shadow.ts`
- `src/lib/dapp/merkle-witness.ts` (single-deposit shortcut for §2.6)
- `src/app/api/dapp/trade-withdraw-prepare/route.ts` (33-root fallback logic)

### 2.2 Pending-order slot probing (L1 stale, ER live)

**The problem.** The matching engine's `init_pending_order_slot` reserves one
of `MAX_PENDING_SLOTS_PER_USER = 4` slots per `(market, trading_key)`. Once
a slot is delegated, L1's account view becomes stale — the live `status` byte
(`Empty`, `Pending`, …) only updates on the ER.

**The hack.** Both `init-slot/route.ts` (for the user) and
`counter-and-match/route.ts` (for the maker) ship the same `chooseFreshSlot`
helper that:

1. Loops `slotIdx` from 0 to `MAX_PENDING_SLOTS_PER_USER - 1`.
2. Reads each `pendingOrderPda` from L1.
3. If the account doesn't exist → `{ slotIdx, needsInit: true }`.
4. If the account exists and is owned by the **delegation program**, re-fetch
   from the ER (`er.getAccountInfo`) — never trust the stale L1 bytes.
5. If status byte (offset `8 + 32 + 32`) is `Empty` (`0`) → reuse this slot
   without re-init.
6. If all 4 slots are `Pending`, fail with a clear "rotate keypair" message.

**Cost.** Up to 8 RPC round-trips per slot pick (4 L1 + 4 ER). Two near-duplicate
implementations.

**File map:**
- `src/app/api/dapp/init-slot/route.ts`
- `src/app/api/dapp/counter-and-match/route.ts` (`chooseFreshSlot`)

### 2.3 Finding "your" match in the `BatchResults` ring buffer

**The problem.** `BatchResults` stores the last 16 matches in a ring keyed by
`next_match_id`. The `write_cursor` field gives you the *most recent* match,
but on a busy market other matches may have landed in between submitting and
reading. We can't just read `results[(write_cursor - 1) % 16]`.

**The hack.** `runTradeL1Settle` in `lib/dapp/run-trade-l1-settle.ts`:

1. Decodes the entire 16-entry ring with `decodeBatchResults`.
2. Searches for an entry whose `(noteBuyer, noteSeller)` pair equals the
   user's quote-note commitment and the maker's note commitment.
3. If none is found, includes a diagnostic message about circuit breaker /
   TWAP / clearing price / write_cursor so we can tell whether matching
   actually ran or was blocked by the oracle.

**Cost.** A 16-entry linear scan, plus error-handling for "nothing matched
because the circuit breaker tripped".

**File map:** `src/lib/dapp/run-trade-l1-settle.ts`.

### 2.4 Auto-zeroing protocol fees

**The problem.** `setup-devnet` provisions `vault_config.fee_rate_bps = 30`
(0.30 %). The demo deposits exactly the bid notional, so any non-zero fee
makes `note_amount - (notional + fee)` underflow → `MatchingError::ConservationViolation`
(`0x178d`).

**The hack.** `lib/dapp/ensure-zero-fee.ts` reads `vault_config` directly,
parses `fee_rate_bps` at the precise byte offset `8 + 32 + 32 + 32 + 8 + 32
+ 32*32 + 20*32 + 20*32 + 1 + 1 + 32` (i.e. after the entire zero-copy Pod
layout), and if it's non-zero, sends `set_protocol_config(fee_rate_bps=0)`
signed by the admin keypair. Pre-flight step in `counter-and-match`.

**Cost.** A hard-coded byte offset that has to be kept in sync with
`programs/vault/src/state.rs`. An indexer would publish a typed view.

**File map:** `src/lib/dapp/ensure-zero-fee.ts`.

### 2.5 SOL top-up for derived keys

**The problem.** The user's seed-derived **trading key**, the demo's **maker**,
and the **admin** all need SOL on devnet for rent + transaction fees, but
the dapp can't ask the user to fund them.

**The hack.** `lib/dapp/top-up-sol.ts` checks each derived key's balance and
sends a `SystemProgram.transfer` from the funder if it's below a threshold.
Called from every API route that needs an unfamiliar signer.

**Cost.** ~6 extra RPC round-trips per trade flow. Funder must be kept full.

**File map:** `src/lib/dapp/top-up-sol.ts`.

### 2.6 `right_path` snapshot for the simple deposit/withdraw demo

**The problem.** The full Merkle replay (§2.1) is heavy. For the
single-deposit demo (`Phase 8` panel), we only need to prove inclusion of
the *most recent* leaf.

**The hack.** `private-deposit/route.ts` reads `vault_config.right_path`
**before** the deposit lands and stashes it in the response. `merkle-witness.ts`
reconstructs the witness from that snapshot using the same insertion math
the on-chain `append_leaf` runs.

This is mathematically clean **only** when the user's leaf is the latest
appended. Any concurrent deposit/settle invalidates it. The route checks
`leaf_count` at withdraw time and 409s if drift is detected.

**Cost.** A whole second witness implementation that can't be used for trades.
This is what motivated §2.1.

**File map:**
- `src/app/api/dapp/private-deposit/route.ts`
- `src/app/api/dapp/withdraw-prepare/route.ts`
- `src/lib/dapp/merkle-witness.ts`

### 2.7 Idempotency probes everywhere

**The problem.** Refresh the page mid-flow and re-run a step → "Allocate:
account already in use" because the PDA was created last time.

**The hack.** Every `init`-style route does `getAccountInfo` first and short-
circuits with `alreadyRegistered: true` (or equivalent). Examples:

- `register-wallet`: probe `walletEntryPda`, skip `create_wallet` if present.
- `init-slot`: see §2.2 — drives `needsInit` from account existence.
- ATAs: built with `createAssociatedTokenAccountIdempotentInstruction` so we
  don't have to probe.

**Cost.** One extra RPC per resumable step. The matrix of "is it ok to
re-run this?" lives implicitly across many route files instead of in a
status service.

### 2.8 Cross-cluster orchestration as a single Next.js handler

**The problem.** A trade flow involves **8+ confirmed transactions** across
**2 clusters** in strict order:

```
admin set_protocol_config (L1)         →  funded admin
maker mint (L1)                        →  funded maker
maker deposit (L1)                     →  vault leaf
maker init pending slot (L1)           →  PDA exists
maker delegate slot (L1 → ER)          →  delegation handoff
maker submit_order (ER)                →  order live in ER
run_batch (ER)                         →  match recorded in BatchResults
undelegate_market (ER → L1)            →  state committed back
lock_note × 2 (L1)                     →  notes locked for settle
ed25519_verify + tee_forced_settle (L1)→  consume input notes, append outputs
```

**The hack.** `counter-and-match/route.ts` does this as a **single API
handler** with sequential `await`s and `sendAndConfirmTransaction` between
each step. If any step times out or fails, the user sees a generic error and
has to retry the whole flow.

**Cost.** No retries, no idempotency across the multi-step sequence, no way
to resume from a half-finished trade. A handful of partially-completed
trades from earlier debugging sessions are still floating around in the
user's devnet account history.

**File map:** `src/app/api/dapp/counter-and-match/route.ts`.

### 2.9 The "list my reclaimable notes" question (currently unsolved)

**The problem.** After a trade, the user owns `note_c` (BASE leg) at some
leaf index. After several trades, they own multiple notes scattered through
the tree. The on-chain leaf is **just a Poseidon hash** — there's no on-chain
field saying "this belongs to owner X". You can't filter by owner without
trial-decrypting every leaf with your spending key, and we don't even have a
ciphertext to decrypt.

**The hack.** `sessionStorage["nyx-trade-withdraw"]` — `counter-and-match`
writes a `tradeWithdrawBuyerBase` hint after each successful settle, and
`TradeBaseWithdrawPanel` reads it back. Works for "the last trade in this
tab" only.

**Status.** Even with that hint, the witness reconstruction in §2.1 races
other vault txs on busy devnet enough that we **commented the panel out**
in `app/dapp/page.tsx` for the demo build. This is the single biggest
indexer-shaped hole in the product.

**File map:**
- `src/lib/dapp/trade-withdraw-storage.ts` (the session key)
- `src/components/dapp/trade-base-withdraw-panel.tsx` (preserved, not rendered)
- `src/app/api/dapp/trade-withdraw-prepare/route.ts` (route still works,
  just not exposed)

### 2.10 Mock-oracle awareness baked into demo defaults

**The problem.** `setup-devnet` provisions a mock Pyth oracle at `TWAP = 100`
with `circuit_breaker_bps = 500` (5 %). Any clearing price outside `[95,
105]` trips the breaker and produces zero matches.

**The hack.** Hard-coded `QUOTE_PER_BASE = 100` (and `ORDER_PRICE_LIMIT = 100`)
in `dapp-trade-flow-panel.tsx` and `counter-and-match/route.ts`, plus README
warnings. No way to introspect the live oracle band.

**File map:**
- `src/components/dapp/dapp-trade-flow-panel.tsx`
- `src/app/api/dapp/counter-and-match/route.ts`

### 2.11 Phantom seed re-derivation per request

**The problem.** Every API route needs the user's seed (to derive
ownerCommitment, spending key, etc.), but we can't store it server-side.

**The hack.** Every request carries `phantomSignatureBase58` +
`ownerPubkeyBase58`. Every API route re-runs `verifyPhantomSeedSignature`
which:

1. Verifies the Ed25519 signature on a deterministic message.
2. SHA-256s the signature → 32-byte master seed.
3. Returns the seed for that single request.

The seed never lives in any persistent store, but every API call eats a
signature verification.

**Cost.** Tiny CPU cost; the bigger cost is *cognitive* — every route author
has to remember to re-verify and never accept the seed directly.

**File map:** `src/lib/dapp/phantom-verify.ts`.

---

## 3 · What an indexer would change

This section is the migration sketch. If you're picking up Nyx and adding an
indexer service, this is your TODO list, ranked by pain reduction.

### 3.1 Architecture sketch

```
Solana L1 program logs ─┐
MagicBlock ER logs    ─┼─►  Geyser plugin / Helius webhook
                       │      │
Oracle TWAP feed      ─┘      ▼
                          ┌────────────────────────┐
                          │   Indexer ingest       │
                          │   - Postgres           │
                          │   - Redis (cache)      │
                          │   - in-memory Merkle   │
                          └─────────┬──────────────┘
                                    │ tRPC / REST / GraphQL
                                    ▼
                          ┌────────────────────────┐
                          │      apps/demo         │
                          │      (and future       │
                          │       Nyx frontends)   │
                          └────────────────────────┘
```

Pick one ingest mechanism (Helius webhooks are zero-ops; Geyser is faster
and self-hosted) and one storage layer (Postgres + Drizzle is plenty —
nothing here is high-write). Optionally cache hot reads in Redis.

### 3.2 Tables to maintain

```sql
-- One row per vault leaf, in insertion order.
vault_leaves(
  leaf_index    bigint PRIMARY KEY,
  commitment    bytea  NOT NULL,
  root_after    bytea  NOT NULL,    -- vault.current_root after this leaf
  source_kind   text   NOT NULL,    -- 'deposit' | 'settle_c' | 'settle_d' | ...
  source_sig    text   NOT NULL,
  slot          bigint NOT NULL,
  inserted_at   timestamptz DEFAULT now()
);

-- Sliding window so witnesses stay valid for the on-chain ROOT_HISTORY_SIZE.
vault_root_history(
  leaf_index   bigint PRIMARY KEY,  -- root applies AFTER this leaf
  root         bytea  NOT NULL,
  still_valid  boolean GENERATED ALWAYS AS (...)  -- inside last 32 leaves
);

-- One row per (market, trading_key, slot_idx) state change.
pending_order_slots(
  market        bytea,
  trading_key   bytea,
  slot_idx      smallint,
  status        smallint,           -- Empty / Pending / ...
  delegated     boolean,
  last_update   bigint,             -- slot
  PRIMARY KEY (market, trading_key, slot_idx)
);

-- Full match history, keyed by match_id (not the 16-entry ring).
match_results(
  match_id        bytea PRIMARY KEY,
  market          bytea,
  note_buyer      bytea,
  note_seller     bytea,
  base_amt        numeric,
  quote_amt       numeric,
  buyer_change    numeric,
  seller_change   numeric,
  buyer_fee       numeric,
  seller_fee      numeric,
  clearing_price  bigint,
  batch_slot      bigint,
  status          smallint,
  -- + every other MatchResult field the dapp uses
);

-- WalletEntry creations (so register-wallet idempotency is one query).
wallet_entries(
  user_commitment bytea PRIMARY KEY,
  owner_pubkey    bytea,
  wallet_pda      bytea,
  created_slot    bigint
);

-- Optional: oracle band cache.
oracle_twap(
  feed_id        bytea,
  twap           bigint,
  circuit_bps    smallint,
  observed_at    timestamptz
);

-- Optional but transformative: notes-per-owner index. Requires the dapp to
-- POST a hint (or the on-chain leaf event to carry one).
note_hints(
  commitment      bytea PRIMARY KEY,
  owner_commit    bytea,
  role            text,              -- 'deposit' | 'note_c' | 'note_d' | ...
  match_id        bytea NULL,
  amount          numeric,
  token_mint      bytea,
  nonce           bytea,
  blinding_r      bytea,
  hint_source     text               -- 'dapp_post' | 'memo' | ...
);
```

### 3.3 Endpoints

| Endpoint                                  | Replaces                            |
| ----------------------------------------- | ----------------------------------- |
| `GET /vault/state`                        | `vaultConfigPda` getAccountInfo + offset math |
| `GET /vault/witness?leafIndex=K`          | Everything in §2.1                  |
| `GET /vault/leaf?commitment=...`          | Trial-derivation                    |
| `GET /pending-slots?trading_key=...&market=...` | All of §2.2                       |
| `GET /match?match_id=...`                 | §2.3 ring scan                      |
| `GET /match/by-notes?buyer=...&seller=...`| §2.3 ring scan (alternative)        |
| `GET /wallet/registered?owner=...`        | §2.7 register-wallet probe          |
| `GET /oracle/safe-band?feed=...`          | §2.10 hard-coded 100                |
| `POST /note-hint`                         | enables §2.9 properly               |
| `GET /notes-by-owner?owner_commit=...`    | §2.9 — finally lists reclaimables   |

### 3.4 What disappears from `apps/demo`

Once an indexer is in place and the dapp routes call it:

| File / function                                                | Becomes              |
| -------------------------------------------------------------- | -------------------- |
| `lib/dapp/vault-leaf-history.ts` (~260 lines)                  | `await indexer.getWitness(leafIndex)` |
| `lib/dapp/merkle-shadow.ts` (~120 lines)                       | Deleted              |
| `lib/dapp/merkle-witness.ts` (~80 lines)                       | Deleted              |
| `chooseFreshSlot` in 2 routes (~50 lines × 2)                  | One indexer call     |
| `BatchResults` ring search in `run-trade-l1-settle.ts`         | One indexer call     |
| `right_path` snapshot in `private-deposit/route.ts`            | Removed              |
| Idempotency `getAccountInfo` probes                            | One indexer call each|
| Hard-coded `VaultConfig` byte offsets in `ensure-zero-fee.ts`  | Typed indexer view   |
| 33-root ring-buffer fallback in `trade-withdraw-prepare`       | Indexer always serves a witness whose root is in the live ring |
| `sessionStorage["nyx-trade-withdraw"]`                         | `GET /notes-by-owner`|
| Mock-oracle awareness                                          | `GET /oracle/safe-band` |

The `TradeBaseWithdrawPanel` (currently commented out in `app/dapp/page.tsx`)
becomes trivially shippable. So does a "claim all my pending notes" UX, which
today is impossible.

### 3.5 What still won't be solved

Some pain isn't indexer-shaped:

- **Browser ZK prover speed.** `VALID_SPEND` is still seconds in snarkjs.
  Move to Halo2 / Plonky3 or off-load to a remote prover (with privacy
  trade-offs).
- **Phantom UX.** The wallet adapter quirks, the "trading key vs Phantom
  key" confusion, signMessage prompts — all still there.
- **Cross-cluster orchestration latency.** ER → L1 commit takes seconds
  during which the user stares at "settling…". Indexer makes it observable
  but not faster.
- **Trust assumption around the indexer.** It must be append-only,
  publicly queryable, and ideally reproducible from chain logs — otherwise
  it's a new centralisation point. Witness paths returned by the indexer
  should be cheaply re-verifiable client-side against the on-chain root.
- **Devnet shared-state churn.** A dedicated cluster (or a per-demo market)
  side-steps most "race with another user" problems regardless of indexer.

### 3.6 Suggested rollout order

1. **Vault leaves + witness endpoint.** Highest ROI — kills §2.1 and §2.6
   in one move and unblocks `TradeBaseWithdrawPanel`.
2. **Pending-order slots view.** Removes the L1-vs-ER stale read dance.
3. **Match results table.** Lets `counter-and-match` look up a match by
   `match_id` instead of scanning a ring.
4. **Wallet registry.** Tiny, but cleans up every `register-wallet`
   idempotency probe.
5. **Note hints.** The transformative one — once we POST `(commitment,
   owner_commit, role, derivation_hints)` after every deposit/settle, the
   indexer can serve "all notes owned by X" and the demo's UX changes shape
   entirely.
6. **Oracle band.** Cosmetic; only needed when we stop hard-coding TWAP.

Each of these is a few hundred lines of indexer code and a one-line swap in
the dapp. The full migration is a 1–2 week project for one person, and the
delta in dapp complexity is roughly the ratio of `apps/demo/src/lib/dapp/*`
shrinking by ~40 %.

---

## 4 · Quick file-tree map

```
apps/demo/
├─ ARCHITECTURE.md                       ← you are here
├─ README.md                             ← user-facing setup & flow
├─ public/circuits/                      ← snarkjs wasm + zkey blobs
├─ src/
│  ├─ app/
│  │  ├─ dapp/page.tsx                   ← panel composition (§2.9 commented)
│  │  └─ api/dapp/                       ← every server route under §2
│  ├─ components/dapp/                   ← UI panels
│  │  └─ trade-base-withdraw-panel.tsx   ← preserved, currently unrendered
│  ├─ lib/dapp/
│  │  ├─ vault-leaf-history.ts           ← §2.1 leaf replay
│  │  ├─ merkle-shadow.ts                ← §2.1 in-memory tree
│  │  ├─ merkle-witness.ts               ← §2.6 single-deposit shortcut
│  │  ├─ run-trade-l1-settle.ts          ← §2.3 BatchResults search + L1 settle
│  │  ├─ ensure-zero-fee.ts              ← §2.4 fee auto-zero
│  │  ├─ top-up-sol.ts                   ← §2.5 derived-key funding
│  │  ├─ trade-withdraw-storage.ts       ← §2.9 sessionStorage key
│  │  ├─ phantom-verify.ts               ← §2.11 per-request seed derive
│  │  └─ ...
│  └─ workers/prover.worker.ts           ← snarkjs in a Web Worker only
└─ ...
```

Anything in `lib/dapp/` whose name contains "merkle", "history", "shadow",
"chooseSlot", or "rightPath" is either §2.1 or §2.6 and is the *first* thing
to delete the day the indexer ships.
