# Nyx Darkpool — Architecture

This document is the deep dive. For a quick look (TL;DR + deployed
addresses + 3-step quickstart) see the top-level [`README.md`](../README.md).

---

## Table of contents

- [Nyx Darkpool — Architecture](#nyx-darkpool--architecture)
  - [Table of contents](#table-of-contents)
  - [System overview](#system-overview)
  - [Project layout](#project-layout)
  - [Privacy architecture](#privacy-architecture)
    - [What is hidden, what is public](#what-is-hidden-what-is-public)
    - [Why an Ephemeral Rollup?](#why-an-ephemeral-rollup)
    - [How `submit_order` becomes invisible](#how-submit_order-becomes-invisible)
  - [Component-by-component walkthrough](#component-by-component-walkthrough)
    - [`programs/vault` — custody + Merkle tree + ZK + settlement](#programsvault--custody--merkle-tree--zk--settlement)
    - [`programs/matching_engine` — CLOB + ER glue](#programsmatching_engine--clob--er-glue)
    - [`crates/darkpool-crypto` — host-side crypto](#cratesdarkpool-crypto--host-side-crypto)
    - [`circuits/` — zero-knowledge proofs](#circuits--zero-knowledge-proofs)
    - [`packages/sdk` — TypeScript client](#packagessdk--typescript-client)
  - [End-to-end transaction flow](#end-to-end-transaction-flow)
  - [Account / PDA reference](#account--pda-reference)
    - [Vault PDAs](#vault-pdas)
    - [Matching engine PDAs](#matching-engine-pdas)
  - [Cryptographic primitives](#cryptographic-primitives)
  - [Security model + threat assumptions](#security-model--threat-assumptions)
  - [What is NOT yet shipped](#what-is-not-yet-shipped)

---

## System overview

```
     ┌───────────────┐ deposit (L1)         ┌─────────────────────┐
     │  User wallet  ├───────────────────► │  vault::deposit     │
     │  (browser)    │   note added to     │  (Solana L1)        │
     └──────┬────────┘   Merkle tree       └─────────────────────┘
            │
            │ submit_order (PER, JWT-gated PER RPC)
            │ ★ side / price / amount / note_commitment NEVER touch L1
            ▼
   ┌────────────────────────┐  run_batch (PER)
   │  PendingOrder PDA      ├──────────────────► uniform-clearing-price
   │  (delegated to ER)     │                    match in the rollup
   └─────────┬──────────────┘
             │ commit + undelegate (PER → L1)
             ▼
       BatchResults snapshot lands back on L1
             │
             │ TEE signs canonical payload, atomic L1 tx
             ▼
   ┌────────────────────────┐
   │  vault::lock_note ×2   │
   │  vault::tee_forced_    │   ── appends note_c (BASE buyer)
   │       settle           │      + note_d (QUOTE seller)
   └─────────┬──────────────┘      + note_fee (protocol)
             │
             │ withdraw (L1, VALID_SPEND proof)
             ▼
       SPL tokens released to the user wallet
```

Three trust boundaries, three layers:

| Layer            | Tech                                | Purpose                                      |
|------------------|-------------------------------------|----------------------------------------------|
| **L1 (Solana)**  | Anchor 0.32 programs (vault + ME)   | Custody, Merkle tree, ZK verifier, settlement |
| **PER (rollup)**  | MagicBlock Ephemeral Rollup         | Hidden order intent + matching                |
| **Client (TS)**  | `@nyx/sdk`, snarkjs, ZK circuits    | Key derivation, proof generation, ix builders |

---

## Project layout

```
nyx-monorepo/
├── programs/                          # On-chain Solana programs (Anchor 0.32)
│   ├── vault/                         # Custody, UTXO Merkle tree, settlement
│   │   ├── src/
│   │   │   ├── lib.rs                 # #[program] entrypoints
│   │   │   ├── state.rs               # VaultConfig, WalletEntry, NullifierEntry,
│   │   │   │                          # ConsumedNoteEntry, NoteLock zero-copy PDAs
│   │   │   ├── merkle.rs              # Incremental Poseidon Merkle tree (depth 20)
│   │   │   ├── errors.rs
│   │   │   ├── instructions/
│   │   │   │   ├── initialize.rs              # Create the global VaultConfig singleton
│   │   │   │   ├── create_wallet.rs           # VALID_WALLET_CREATE Groth16 → WalletEntry
│   │   │   │   ├── deposit.rs                 # Pull SPL → append note commitment
│   │   │   │   ├── lock_note.rs               # TEE-only: pin a note to an order_id
│   │   │   │   ├── release_lock.rs            # Release expired note locks
│   │   │   │   ├── tee_forced_settle.rs       # Ed25519-verified atomic settlement
│   │   │   │   ├── withdraw.rs                # VALID_SPEND Groth16 → SPL transfer out
│   │   │   │   ├── set_protocol_config.rs     # Admin: rotate protocol-owner / fee bps
│   │   │   │   ├── rotate_root_key.rs         # PER root-key rotation
│   │   │   │   └── reset_merkle_tree.rs       # DEVNET-ONLY: tree wipe for tests
│   │   │   └── zk/                            # Embedded Groth16 verifier-key consts
│   │   └── tests/                             # litesvm integration tests
│   │
│   └── matching_engine/                       # CLOB + ER session driver
│       ├── src/
│       │   ├── lib.rs
│       │   ├── state/
│       │   │   ├── pending_order.rs           # ★ Privacy-fix slot PDA
│       │   │   ├── dark_clob.rs               # Per-market metadata (mints, oracle)
│       │   │   ├── matching_config.rs         # Tick size, min order size, etc.
│       │   │   ├── batch_results.rs           # Snapshot of last batch's matches
│       │   │   ├── match_result.rs            # Single match record (one trade)
│       │   │   ├── change_note.rs             # Re-lockable partial-fill change leg
│       │   │   ├── fee_accumulator.rs         # In-batch protocol fee accrual
│       │   │   ├── order_record.rs            # Legacy order-book row (cancel-by-id)
│       │   │   └── pyth.rs                    # Pyth Pull-v2 + NYXMKPTH mock parser
│       │   ├── instructions/
│       │   │   ├── init_market.rs             # L1: create the three market PDAs
│       │   │   ├── init_mock_oracle.rs        # L1 (devnet): NYXMKPTH oracle stub
│       │   │   ├── init_pending_order_slot.rs # ★ L1 (idempotent): empty slot PDA
│       │   │   ├── delegate_pending_order.rs  # ★ L1: hand slot to ER validator
│       │   │   ├── delegate_dark_clob.rs      # L1: hand DarkCLOB PDA to ER
│       │   │   ├── delegate_matching_config.rs
│       │   │   ├── delegate_batch_results.rs
│       │   │   ├── submit_order.rs            # ★ PER-only single-account write
│       │   │   ├── cancel_order.rs            # ★ PER-only owner-authenticated cancel
│       │   │   ├── run_batch.rs               # ★ PER: matches PendingOrder remaining_accounts
│       │   │   ├── commit_market_state.rs     # PER: ScheduleCommit (keeps delegation)
│       │   │   ├── undelegate_market.rs       # PER: ScheduleCommitAndUndelegate
│       │   │   └── configure_access.rs        # PER access-control list
│       │   └── errors.rs
│       └── tests/                              # 23 litesvm integration tests
│
├── crates/
│   └── darkpool-crypto/                       # Host-side cryptography (ZK-input prep)
│       └── src/
│           ├── poseidon.rs                    # Light-protocol Poseidon2 wrapper
│           ├── note.rs                        # Note commitment: Poseidon6(mint_lo,mint_hi,amt,owner,nonce,r)
│           ├── nullifier.rs                   # Nullifier: Poseidon2(spending_key, note_commitment)
│           ├── keys.rs                        # Spending / viewing key derivation (HKDF-SHA256 + KMAC256)
│           ├── viewing_keys.rs                # Owner-commitment + r-derivation chain
│           ├── user_commitment.rs             # User commitment Poseidon helper
│           └── field.rs                       # BN254 Fr range + LE/BE encoding helpers
│
├── circuits/                                  # Circom 2 zero-knowledge circuits
│   ├── valid_wallet_create/circuit.circom     # Proves knowledge of (sk, vk, r0..r2) for Wallet PDA
│   ├── valid_spend/circuit.circom             # Proves note ownership + Merkle inclusion + nullifier
│   └── build/                                 # Compiled .wasm + .zkey (gitignored, generated)
│
├── packages/
│   └── sdk/                                   # @nyx/sdk — TypeScript client library
│       ├── src/
│       │   ├── client.ts                      # NyxDarkpoolClient factory
│       │   ├── providers.ts                   # Injectable Solana / ER providers
│       │   ├── idl/
│       │   │   ├── seeds.ts                   # Wire-mirror of Rust SEED consts
│       │   │   ├── vault-client.ts            # buildDeposit / lock_note / settle / withdraw ixs
│       │   │   ├── matching-engine-client.ts  # PendingOrder helpers + submit/cancel/run_batch ixs
│       │   │   └── er-client.ts               # MagicBlock delegate / commit / undelegate ixs
│       │   ├── orders/
│       │   │   ├── submit-order.ts            # High-level submit-order pipeline (ER-only)
│       │   │   └── cancel-order.ts            # Cancel via the ER session
│       │   ├── batch/
│       │   │   └── inclusion-proof.ts         # Decode BatchResults + extract MatchResult records
│       │   ├── settlement/
│       │   │   ├── settle-builder.ts          # Build canonical MatchResultPayload + Ed25519 ix
│       │   │   └── settlement-watcher.ts      # Poll the on-chain settlement events
│       │   ├── per/
│       │   │   ├── attestation.ts             # PER session attestation glue
│       │   │   └── session-manager.ts         # JWT-gated ER RPC client
│       │   ├── keys/                          # Spending / viewing key gen + rotation + commit
│       │   ├── utxo/                          # Note + deposit + withdraw helpers (TS mirror of Rust)
│       │   └── zk/
│       │       └── prover-suite.ts            # snarkjs-fullProve adapter
│       └── tests/                             # 88 vitest tests (76 unit + 12 devnet-gated)
│
├── scripts/
│   ├── build-circuits.sh                      # Compile circom + run setup + write Rust VK consts
│   ├── deploy-devnet.sh                       # Idempotent program deploy to devnet
│   ├── setup-devnet.sh                        # Create + fund .devnet/keypairs/*
│   ├── parse-vk-to-rust.js                    # Convert snarkjs verification_key.json → Rust consts
│   ├── download-ptau.sh                       # Pull the powers-of-tau ceremony file
│   └── dev-commands.md                        # Master dev command cheat-sheet
│
├── .devnet/                                   # gitignored: keypairs + e2e-config.json
│   └── keypairs/                              # admin / TEE / root_key + alice/bob personas
│
├── Anchor.toml                                # Program IDs + provider config
├── Cargo.toml                                 # Rust workspace (programs + crypto crate)
├── package.json                               # npm workspaces (sdk + circuits)
└── rust-toolchain.toml                        # Pinned toolchain for build reproducibility
```

The `darkpool/` directory and the top-level `*.md` design notes
(`darkpool_protocol_spec_v3_changed.md`, `change_note_implementation.md`,
`partial_fill_and_fee_notes.md`, `order_privacy_fix.md`) are kept for
historical reference — they are NOT source-of-truth for the live code.
The code is.

---

## Privacy architecture

### What is hidden, what is public

| Object                                          | L1 visible? | Notes                                      |
|-------------------------------------------------|-------------|--------------------------------------------|
| **Order side / price / amount**                 | NO          | Stays in the ER until `run_batch` matches  |
| **Order's collateral note commitment**          | NO          | Same — only inside the ER                  |
| **User's trading-key signature on submit_order**| NO          | The whole submit tx lives in the ER        |
| **`note_commitment` of the deposit note**       | YES         | Public on `vault::deposit` (always was)    |
| **Deposit amount / mint**                       | YES         | SPL transfer is on L1                      |
| **Match clearing price + matched volume**       | YES         | Surfaces in `BatchResults` after commit    |
| **Settlement note commitments (note_c, _d, _e)**| YES         | TEE appends them in `tee_forced_settle`    |
| **Withdrawal amount + recipient ATA**           | YES         | SPL transfer-out is on L1                  |

The unmatched anonymity-set therefore consists of every order that
*entered* the ER but did not settle this batch. Once an order matches,
the leaked information is the *aggregate* match (price, total volume,
which two `note_commitment`s were spent) — not the individual order
intent that produced it.

### Why an Ephemeral Rollup?

A pure-L1 dark pool would require a TEE that *commits* L1 transactions
on the user's behalf so order intent never appears in any tx the user
signs. That is operationally fragile and adds a trusted relayer.

MagicBlock's Ephemeral Rollup gives us the property "this PDA is
writable inside an authenticated rollup session, and only commits a
*compressed snapshot* back to L1 when we explicitly schedule a commit."
We **delegate** PDAs we want to keep private (PendingOrder slots) and
**commit only the aggregate** (`BatchResults`) once a batch finishes.

### How `submit_order` becomes invisible

The privacy fix follows the [MagicBlock rock-paper-scissors
pattern](https://docs.magicblock.gg/developers/cookbook):

1. **L1, one-time per user-market pair**:
   `init_pending_order_slot(market, slot_idx)` — allocates an EMPTY
   `PendingOrder` PDA. The L1 init tx contains zero order intent.
   `delegate_pending_order(market, slot_idx)` — hands the PDA to the ER
   validator via the `#[delegate]` macro from `ephemeral_rollups_sdk`.
   From this point on, **the PDA is only writable inside the ER**.

2. **ER, per order**: `submit_order(args)` — sent to the MagicBlock ER
   RPC (gated by a PER JWT session). Writes order intent (side,
   amount, price_limit, note_commitment, user_commitment, …) directly
   into the user's delegated slot. The slot is bound by Anchor seeds to
   `(PENDING_ORDER_SEED, market, trading_key, slot_idx)` — a stranger
   cannot resolve to someone else's slot.

3. **ER, per batch**: `run_batch(market)` — the operator passes all
   participating PendingOrder PDAs as `remaining_accounts`. The handler
   reads each slot, runs the Phase-4 uniform-clearing-price match (with
   Pyth circuit breaker), writes results into the delegated
   `BatchResults` PDA, and rotates collateral on partially-filled
   slots' `collateral_note`.

4. **ER → L1**: `undelegate_market` — CPIs
   `ScheduleCommitAndUndelegate` on the magic program. MagicBlock
   commits the new `DarkCLOB` / `MatchingConfig` / `BatchResults` state
   back to L1 and returns ownership of those PDAs to `matching_engine`.
   PendingOrder slots stay delegated (so future batches can match
   without re-delegation).

5. **L1 settlement**: the TEE builds a `MatchResultPayload`, signs the
   canonical hash, and submits two atomic L1 txs:
   - `lock_note(note_a) + lock_note(note_b)` (allocates the
     `NoteLock` PDAs that pin the buyer's + seller's deposit notes)
   - `Ed25519 verify + tee_forced_settle` (consumes the locked notes,
     appends `note_c` (BASE buyer) + `note_d` (QUOTE seller) + a
     protocol fee leaf to the Merkle tree)

   Splitting into two txs is necessary because the combined tx exceeds
   Solana's 1232-byte tx cap. Privacy is unaffected — `lock_note` only
   references the note commitment, the deposit amount, and an order
   ID. Both fields were already public on L1 from the `deposit` ix.

---

## Component-by-component walkthrough

### `programs/vault` — custody + Merkle tree + ZK + settlement

**Singletons.** `VaultConfig` is a global zero-copy PDA holding the
incremental Merkle tree state (depth 20 = 1 048 576 leaves), the last
32 historical roots, the TEE's Ed25519 pubkey, the protocol-fee config,
and a "right path" of rightmost filled nodes per level so every append
is `O(depth)` hashes.

**Per-leaf PDAs.** Every spent or locked note has its own PDA so that
two transactions referencing the same note collide at PDA-allocation
time:
- `WalletEntry` (seed `wallet`) — registered user commitments.
- `NullifierEntry` (seed `nullifier`) — VALID_SPEND-consumed notes.
- `ConsumedNoteEntry` (seed `consumed_note`) — TEE-settle-consumed notes.
- `NoteLock` (seed `note_lock`) — TEE pin between match and settle.

**Settlement.** `tee_forced_settle` is the heart of Phase-5. It walks the
transaction's instruction list via `sysvar::instructions::load_instruction_at_checked`,
finds the `Ed25519Program` precompile ix, asserts that
`pubkey == VaultConfig.tee_pubkey` and that
`msg == canonical_payload_hash(payload)` (SHA-256 over a domain tag
`b"nyx-match-v5"` + a fixed-order serialisation of every field of the
payload), and only then proceeds to:
1. Verify the buyer's and seller's `NoteLock` PDAs match `note_a_commit`
   / `note_b_commit` and have not expired.
2. Allocate two `ConsumedNoteEntry` PDAs (idempotency lock — a second
   identical match cannot replay).
3. Enforce the per-leg conservation law
   `note.amount == trade_leg + change_leg + fee_leg` *exactly* before
   writing state.
4. Append `note_c` (BASE → buyer's owner_commitment), `note_d`
   (QUOTE → seller's owner_commitment), and `note_fee`
   (proportional cut → `protocol_owner_commitment`) to the Merkle tree.
5. Emit `Settled { match_id, … }`.

### `programs/matching_engine` — CLOB + ER glue

**Per-market triple.** Each market is parameterised by three PDAs:
`DarkCLOB` (mints + oracle pubkey + version), `MatchingConfig` (tick
size, batch interval, circuit breaker bps, min order size), and
`BatchResults` (last-batch snapshot — readable from L1 after commit).

**PendingOrder PDA (the privacy fix).** One per (user, market, slot_idx).
Up to `MAX_PENDING_SLOTS_PER_USER = 4` concurrent orders per user per
market. Status state machine:

```
   Empty ──► Pending ──► Matched / Expired / Cancelled
     ▲                         │
     └─── reuse (slot.clear()) ┘
```

**Matching algorithm (`run_batch`).** Phase-4 uniform clearing price:
sort bids descending, asks ascending, find the price that maximises
matched volume, and fill all crossing orders at that single clearing
price. Tie-break by `arrival_slot` (FIFO at equal price). Pyth circuit
breaker: if the clearing price diverges from the oracle TWAP by more
than `circuit_breaker_bps`, the batch is skipped (no settlement). Each
match produces a `MatchResult` with the four note commitments
(`note_a`, `note_b`, `note_c`, `note_d`) that the TEE will later sign +
settle.

### `crates/darkpool-crypto` — host-side crypto

This crate is the *only* place where TS and Rust must agree on
deterministic byte layouts. Every TS implementation (in `packages/sdk`)
has a Rust parity test (in `packages/sdk/tests/*-parity.test.ts`) that
shells out to a CLI helper compiled from
`crates/darkpool-crypto/examples/*` and compares fixture vectors
byte-for-byte. The crate is intentionally kept off the SBF target (it
uses heap, RNG, etc.) — only the on-chain verifier consumes its outputs.

Key derivation chain (HKDF-SHA256 for Ed25519 / spending key, KMAC256 for
viewing key and per-note blinding — see `crates/darkpool-crypto/src/keys.rs`):

```
    master_seed (64 B)
     ├── HKDF-SHA256("darkpool_spend_key_v1", 512b → mod r)   ──► spending_key  (s)
     ├── KMAC256   ("darkpool_viewing_key_v1", 512b → mod r)   ──► viewing_key   (v)
     ├── HKDF-SHA256("darkpool_root_key_v1", 32 B)            ──► root_key (Ed25519)
     ├── HKDF-SHA256("darkpool_trading_key_v1" ‖ offset, 32B) ──► trading_key(offset)
     └── KMAC256   ("note_blinding_v1" ‖ counter, 512b → mod r) ──► blinding_r(i)

    user-commitment chain (independent r0, r1, r2 blinders):
        leafPair    = Poseidon2( Poseidon3(root_lo, root_hi, r0),
                                 Poseidon2(s, r1) )
        user_commit = Poseidon2( leafPair, Poseidon2(v, r2) )

    owner-commitment chain (separate r_owner blinder, reused across all notes):
        owner_commitment = Poseidon2(s, r_owner)
```

Note commitment: `note = Poseidon6(mint_lo, mint_hi, amount, owner_commitment, nonce, blinding_r)`.
The Solana mint pubkey is split into two 128-bit halves because a single
BN254 Fr element cannot hold all 256 bits of a pubkey.

Nullifier: `nullifier = Poseidon2(spending_key, note_commitment)`. Bound to
the commitment, not the leaf index — so two notes with identical contents
but different positions still have different commitments (because
`blinding_r` depends on the leaf-time counter) and therefore different
nullifiers. Leaks nothing about which note was spent unless the spending
key is known.

### `circuits/` — zero-knowledge proofs

Two Groth16 circuits, both pre-compiled to `.wasm` (witness gen) +
`.zkey` (proving key) by `scripts/build-circuits.sh`:

- **VALID_WALLET_CREATE**: proves "I know `(root_pubkey_lo, root_pubkey_hi,
  s, v, r0, r1, r2)` such that the user-commitment chain (above) yields
  `user_commitment`." **One** public input: `user_commitment` (a single
  32-byte BN254 Fr element — Poseidon output is always in-field).

- **VALID_SPEND**: proves "I know `(s, r_owner, nonce, blinding_r,
  merkle_path[20], merkle_indices[20])` such that
  `owner_commitment = Poseidon2(s, r_owner)`,
  `note = Poseidon6(mint_lo, mint_hi, amount, owner_commitment, nonce, blinding_r)`,
  `note` is in the Merkle tree at `merkle_root`, and
  `nullifier == Poseidon2(s, note)`." **Five** public inputs in this
  order: `(merkle_root, nullifier, mint_lo, mint_hi, amount)`. Only the
  mint is split as `[lo, hi]` because a Solana pubkey is 256 bits;
  `merkle_root` and `nullifier` are Poseidon outputs (single Fr each).

The verifier keys are baked into the on-chain `vault` program at
`programs/vault/src/zk/vk_*.rs` (regenerated from the snarkjs JSON via
`scripts/parse-vk-to-rust.js`).

### `packages/sdk` — TypeScript client

Thin, no-magic, factory-function API. Three guarantees:
1. **No Anchor IDL parser at runtime.** The SDK hand-codes every
   instruction discriminator + Borsh layout. Faster, less fragile, and
   the ix builder is the source of truth for the on-chain wire format.
2. **Injectable providers.** Every long-lived object (`Connection`, ER
   `Connection`, `PerSessionManager`, `Signer`, prover suite) is passed
   into the factory. Easy to mock in tests.
3. **Staged errors.** Errors are tagged with the stage they were thrown
   from (`SubmitStage`, `SettleStage`, `WithdrawStage`, …) so a UI can
   render *what was happening* when something failed.

Notable modules:
- `idl/matching-engine-client.ts` — `pendingOrderPda`,
  `buildInitPendingOrderSlotInstruction`,
  `buildDelegatePendingOrderInstruction`,
  `buildSubmitOrderInstruction`, `buildCancelOrderInstruction`,
  `buildRunBatchInstruction`.
- `idl/vault-client.ts` — every `vault` ix builder +
  `buildLockNoteInstruction` (TEE-side allocation of `NoteLock` PDAs).
- `idl/er-client.ts` — `openDualConnections`, `waitForL1AccountChange`,
  `buildDelegateDarkClobInstruction`,
  `buildCommitMarketStateInstruction`,
  `buildUndelegateMarketInstruction`.
- `orders/submit-order.ts` — high-level pipeline: derive note → build
  args → send to ER RPC → return ix-signature + inclusion commitment.
- `settlement/settle-builder.ts` — canonical `MatchResultPayload`
  Rust-mirror, Ed25519 precompile ix builder, `buildSettleIx`.

---

## End-to-end transaction flow

A complete trade in the privacy-fix flow (from a fresh user to settled
balances). Each row is one transaction. Cluster column is L1 (Solana
mainnet/devnet) or ER (MagicBlock Ephemeral Rollup).

| #     | Cluster | Instruction(s)                                                             | Who signs                      | Privacy property                                            |
|-------|---------|----------------------------------------------------------------------------|--------------------------------|-------------------------------------------------------------|
| 1     | L1      | `vault::create_wallet` (with VALID_WALLET_CREATE proof)                   | user payer                     | links `user_commitment` to a Solana payer; identity-only.   |
| 2     | L1      | `vault::deposit`                                                           | user payer                     | reveals deposit amount + mint (necessarily — it's an SPL transfer). |
| 3a    | L1      | `matching_engine::init_pending_order_slot`                                 | user trading_key               | empty PDA, **zero order intent**.                           |
| 3b    | L1      | `matching_engine::delegate_pending_order`                                  | funder + user trading_key      | hand slot to ER validator.                                  |
| 4     | L1      | `matching_engine::delegate_dark_clob` + delegate_matching_config + delegate_batch_results | admin                | hand market PDAs to ER (one-time per market).             |
| 5     | **ER**  | `matching_engine::submit_order`                                           | user trading_key               | **HIDDEN** — order intent never on L1.                      |
| 6     | **ER**  | `matching_engine::run_batch` (operator-driven, periodic)                  | TEE / operator                 | match all delegated slots in the rollup.                    |
| 7     | **ER**  | `matching_engine::undelegate_market`                                      | TEE / operator                 | commits BatchResults back to L1 + returns ownership.        |
| 8     | L1      | poll: `BatchResults` PDA owner = matching_engine                          | none                           | confirm L1 commit landed.                                    |
| 9a    | L1      | `vault::lock_note(note_a)` + `vault::lock_note(note_b)`                   | TEE                            | references commitments already public from deposit.         |
| 9b    | L1      | `Ed25519` precompile + `vault::tee_forced_settle`                         | TEE                            | atomic note_a/b consume + note_c/d/fee append.              |
| 10    | L1      | `vault::withdraw` (with VALID_SPEND proof)                                | recipient                      | spends a note, reveals amount + mint + recipient ATA.       |

In the running tests, steps 3a/3b happen once per persona ever (slot
PDAs are reused), step 4 happens once per market ever, and step 5 is
the hot-path ER tx that users hit.

---

## Account / PDA reference

### Vault PDAs

| PDA                  | Seeds                                                | Purpose                                |
|----------------------|------------------------------------------------------|----------------------------------------|
| `VaultConfig`        | `["vault_config"]`                                   | Singleton — Merkle tree + TEE pubkey   |
| `WalletEntry`        | `["wallet", commitment]`                             | One per registered user commitment     |
| `NullifierEntry`     | `["nullifier", nullifier]`                           | One per VALID_SPEND-consumed note      |
| `ConsumedNoteEntry`  | `["consumed_note", note_commitment, match_id]`       | One per TEE-settled note               |
| `NoteLock`           | `["note_lock", note_commitment]`                     | TEE pin between match and settle       |
| Vault token ATA      | `["vault_token", mint]`                              | Per-mint custody account               |

### Matching engine PDAs

| PDA              | Seeds                                                          | Purpose                                                  |
|------------------|----------------------------------------------------------------|----------------------------------------------------------|
| `DarkCLOB`       | `["dark_clob", market]`                                        | Mints + oracle + version                                 |
| `MatchingConfig` | `["matching_config", market]`                                  | Tick size, min order size, batch interval, circuit-bps   |
| `BatchResults`   | `["batch_results", market]`                                    | Last batch snapshot (committed back to L1 from ER)       |
| `PendingOrder`   | `["pending_order", market, trading_key, slot_idx]`             | **Privacy-fix**: per-user delegated order slot           |
| `MockOracle`     | `["mock_oracle", market]`                                      | DEVNET-ONLY NYXMKPTH stub (TWAP)                         |

---

## Cryptographic primitives

| Primitive        | Choice                                                    | Where                                                  |
|------------------|-----------------------------------------------------------|--------------------------------------------------------|
| Curve            | BN254 (alt_bn128)                                          | Groth16 verifier on-chain, snarkjs prover off-chain    |
| Hash (in-circuit)| Poseidon2 over BN254 Fr                                    | Note commitments, nullifiers, Merkle, user commitments |
| Hash (ambient)   | SHA-256 / SHA3                                             | Inclusion commitment, key derivation, payload hash     |
| Signature        | Ed25519 (Solana Ed25519 precompile)                        | TEE attestation in `tee_forced_settle`                 |
| KEM              | None — direct payload to TEE via PER session              | (planned: TLS+attestation channel)                     |
| ZK proof system  | Groth16                                                    | VALID_WALLET_CREATE, VALID_SPEND                       |
| Merkle tree      | Incremental Poseidon, depth 20, 32-root ring buffer       | `vault::merkle.rs`                                     |

The on-chain Groth16 verifier is `groth16-solana` v0.2.0 (the alt_bn128
syscall path). Both circuits use the same Powers-of-Tau ceremony file
(downloaded by `scripts/download-ptau.sh`).

---

## Security model + threat assumptions

What the system protects against:

- **Front-running on L1** of unmatched orders (their intent is in the
  ER, not on L1).
- **Replay of TEE-signed settlements** — `consumed_note` PDAs lock both
  legs. A second identical `tee_forced_settle` collides at PDA
  allocation.
- **Withdrawals without ownership proof** — VALID_SPEND requires
  knowledge of the spending key; `nullifier` PDAs prevent double-spend.
- **Conservation violations** — `tee_forced_settle` enforces
  `note.amount == trade_leg + change_leg + fee_leg` *exactly* before
  state mutation; the TEE cannot "create" tokens.
- **Mismatched canonical hashes** — the `Ed25519` precompile message
  must equal `canonical_payload_hash(payload)`; a TEE that signs a
  different message than the on-chain payload is rejected.

What the system explicitly does **not** yet protect against (see
"What is NOT yet shipped" below):

- A compromised TEE host (privacy-fix is in place, but the TEE is a
  software keypair, not a real attested enclave yet).
- Aggregate trade-level analysis after `BatchResults` commits — the
  match volume and price are public.
- Network-level traffic analysis of who is connecting to the ER RPC
  (mitigated by the PER JWT session manager but not eliminated).

---

## What is NOT yet shipped

The privacy fix closes the biggest open item ("submit_order leaks
intent on L1"). Remaining backlog (mirrored in
`scripts/dev-commands.md` §13):

1. **Real TDX/SEV TEE + remote attestation** (Phase 6). The TEE is
   currently a local Ed25519 keypair acting as the signing authority.
   Production deploys must pin the key inside an attested enclave.
2. **Partial-fill + re-lock scenario** exercised end-to-end on devnet.
   The on-chain code paths exist (and 2 of the 12 `run_batch` tests
   cover it in litesvm) but no devnet test currently drives the
   collateral rotation across two batches.
3. **Emergency `force_undelegate_on_l1`** admin ix (pressure valve if
   the ER is down).
4. **Continuous ER ↔ L1 commit scheduler** inside the TEE loop. Today
   the test commits manually via `undelegate_market`. Production wants
   `commit_market_state` (keeps delegation) every N slots so settlement
   can pick up matches without a full undelegate cycle.
5. **Oracle refresh inside long-running ER sessions** — Pyth Pull-v2
   accounts are clone-at-open today.