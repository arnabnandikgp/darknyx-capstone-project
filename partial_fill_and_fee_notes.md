# Design Changes: Partial Fill Re-lock & Fee Note Batching

Two protocol-level vulnerabilities are addressed here. Both require coordinated changes across the matching engine, vault program, and SDK.

---

## Change 1 — Partial Fill Re-lock (Option A)

**Why:** When an order partially fills, the input note is consumed and a change note is created. Without this change, the remaining unfilled order quantity has no backing collateral — the CLOB holds an orphan order that cannot settle. This change makes the TEE atomically re-lock the change note against the continuing order within the same settlement transaction, so the order can keep filling in subsequent batches without any user action.

---

### 1.1 `programs/matching_engine/src/state/order.rs`

Add a `collateral_note` field to the `Order` struct so the CLOB always knows which note commitment is currently backing each order:

```rust
pub struct Order {
    pub order_id:           [u8; 16],
    pub owner_commitment:   [u8; 32],
    pub collateral_note:    [u8; 32],  // note commitment currently locked for this order
    pub side:               Side,
    pub base_token:         Pubkey,
    pub quote_token:        Pubkey,
    pub price_limit:        u64,
    pub total_quantity:     u64,       // original full order quantity
    pub filled_quantity:    u64,       // cumulative amount filled so far
    pub remaining_quantity: u64,       // total_quantity - filled_quantity
    pub min_fill_qty:       u64,
    pub expiry_slot:        u64,
    pub order_type:         OrderType,
}
```

The matching engine must update `filled_quantity`, `remaining_quantity`, and `collateral_note` after each partial fill.

---

### 1.2 `programs/matching_engine/src/state/match_result.rs`

Add fields for the re-lock instruction so the vault program can atomically lock the change note in the same transaction as settlement:

```rust
pub struct MatchResult {
    pub note_buyer:              [u8; 32],
    pub note_seller:             [u8; 32],
    pub owner_buyer:             [u8; 32],
    pub owner_seller:            [u8; 32],
    pub buyer_note_value:        u64,
    pub seller_note_value:       u64,
    pub base_amt:                u64,
    pub quote_amt:               u64,
    pub buyer_change_amt:        u64,
    pub seller_change_amt:       u64,
    // Re-lock fields — populated only when order has unfilled remainder
    pub buyer_relock_order_id:   Option<[u8; 16]>,
    pub buyer_relock_expiry:     Option<u64>,
    pub seller_relock_order_id:  Option<[u8; 16]>,
    pub seller_relock_expiry:    Option<u64>,
    pub price:                   u64,
    pub batch_slot:              u64,
}
```

---

### 1.3 `programs/vault/src/instructions/tee_settle.rs`

Update `tee_forced_settle` to atomically re-lock change notes when a re-lock order_id is provided. All steps must be atomic — if any step fails, the entire transaction rolls back:

```rust
pub fn tee_forced_settle(
    ctx: Context<TeeSettle>,
    match_result: MatchResult,
    tee_signature: [u8; 64],
    nullifier_a: [u8; 32],
    nullifier_b: [u8; 32],
    note_c_commitment: [u8; 32],
    note_d_commitment: [u8; 32],
    note_e_commitment: Option<[u8; 32]>,   // buyer change
    note_f_commitment: Option<[u8; 32]>,   // seller change
    // Fee notes (see Change 2 below)
    note_fee_commitment: Option<[u8; 32]>, // batch fee note, None if zero fees
) -> Result<()>
```

Execution order inside the handler — enforce strictly:

```
1. Verify TEE signature over match_result hash
2. Assert nullifier_a and nullifier_b not in nullifier_set
3. Assert C(note_A) and C(note_B) not in consumed_notes
4. Assert C(note_A) is locked with matching order_id (if relock specified)
5. Assert C(note_B) is locked with matching order_id (if relock specified)
6. Verify conservation laws (see below)
7. Remove lock PDAs for note_A and note_B
8. Insert nullifier_a and nullifier_b into nullifier_set
9. Insert C(note_A) and C(note_B) into consumed_notes
10. Insert C(note_C) into Merkle tree
11. Insert C(note_D) into Merkle tree
12. If note_e_commitment is Some: insert into Merkle tree
13. If note_f_commitment is Some: insert into Merkle tree
14. If note_fee_commitment is Some: insert into Merkle tree
15. If buyer_relock_order_id is Some: create NoteLocks PDA for note_e_commitment
16. If seller_relock_order_id is Some: create NoteLocks PDA for note_f_commitment
```

Steps 15 and 16 require `note_e_commitment` and `note_f_commitment` to be `Some` respectively. If a re-lock is requested but no change note was created, return `ErrorCode::RelockRequiresChangeNote`.

---

### 1.4 Conservation law update

Enforce before any state is written, accounting for fees (see Change 2):

```rust
let buyer_fee  = match_result.buyer_fee_amt;
let seller_fee = match_result.seller_fee_amt;

require!(
    match_result.buyer_note_value ==
        trade_notional
        .checked_add(match_result.buyer_change_amt).unwrap()
        .checked_add(buyer_fee).unwrap(),
    ErrorCode::ConservationViolation
);
require!(
    match_result.seller_note_value ==
        match_result.base_amt
        .checked_add(match_result.seller_change_amt).unwrap()
        .checked_add(seller_fee).unwrap(),
    ErrorCode::ConservationViolation
);
```

---

### 1.5 `programs/matching_engine/src/instructions/run_batch.rs`

Add pre-match guard to prevent matching orders that are too close to expiry for settlement to land safely:

```rust
const SETTLEMENT_BUFFER_SLOTS: u64 = 20;

fn is_order_safe_to_match(order: &Order, current_slot: u64) -> bool {
    order.expiry_slot > current_slot + SETTLEMENT_BUFFER_SLOTS
}
```

Drain orders that fail this check before the matching pass. Release their note locks.

After a partial fill, update the order's `collateral_note` to the new change note commitment and `filled_quantity` / `remaining_quantity` accordingly before the next batch runs.

---

### 1.6 `packages/sdk/src/settlement/settlement-watcher.ts`

Update `MatchNotification` to surface re-lock status to the relayer:

```typescript
interface MatchNotification {
  matchId:            string;
  isPartialFill:      boolean;
  filledQuantity:     bigint;
  remainingQuantity:  bigint;
  tradeProceedsNote:  NotePlaintext;
  changeNote?:        NotePlaintext;   // undefined if exact fill
  relockActive:       boolean;         // true = change note re-locked, order continues
  matchResult:        MatchResult;
}
```

The relayer must store both `tradeProceedsNote` and `changeNote` on every partial fill. If `relockActive` is true, the relayer should not resubmit the order — it is already continuing via the re-locked change note.

---

## Change 2 — Fee Note Batching

**Why:** If protocol fees are collected as a transparent SPL token transfer to a public ATA, observers can reverse-engineer matched quantities from the fee amount. If fees are simply left in the vault without a corresponding note, the solvency invariant breaks: `vault_balance > sum(all active notes)`. Fee notes — standard note commitments addressed to the protocol's owner commitment — solve both problems. Batching one fee note per batch per token type (rather than per match) reduces Merkle tree growth.

---

### 2.1 `programs/vault/src/state/vault_state.rs`

Add the protocol's registered owner commitment:

```rust
pub struct VaultState {
    pub admin:                    Pubkey,
    pub tee_pubkey:               Pubkey,
    pub protocol_owner_commitment: [u8; 32],  // protocol's shielded identity
    pub fee_rate_bps:             u16,         // e.g. 30 = 0.30%
    pub paused:                   bool,
}
```

The `protocol_owner_commitment` is set at initialisation and can only be updated by the admin. It is the commitment that owns all fee notes.

---

### 2.2 `programs/matching_engine/src/state/fee_accumulator.rs`

New struct — the TEE maintains this in memory per batch per token:

```rust
pub struct FeeAccumulator {
    pub token_mint:       Pubkey,
    pub accumulated_fees: u64,
    pub batch_slot:       u64,
}
```

At the end of each batch, if `accumulated_fees > 0` for a given token, the TEE computes a single fee note:

```rust
// Inside the enclave at batch close
let r_fee   = generate_random_blinding_factor_in_enclave();
let nonce   = poseidon(&[protocol_owner_commitment, &batch_slot.to_le_bytes()]);
let fee_commitment = poseidon(&[
    token_mint_lo, token_mint_hi,
    accumulated_fees.to_le_bytes(),
    protocol_owner_commitment,
    nonce,
    r_fee,
]);
// Reset accumulator for next batch
accumulated_fees = 0;
```

The fee note plaintext is delivered to the protocol's relayer via the protocol's own authenticated PER session (the protocol has a Trading Key in the Permission Group like any user).

---

### 2.3 `programs/matching_engine/src/state/match_result.rs`

Add per-side fee amounts to `MatchResult` so the vault program can verify the conservation law:

```rust
pub struct MatchResult {
    // ... all existing fields ...
    pub buyer_fee_amt:  u64,   // fee deducted from buyer's input note
    pub seller_fee_amt: u64,   // fee deducted from seller's input note
}
```

Fee amounts are computed by the matching engine as:

```rust
let buyer_fee  = (trade_notional * fee_rate_bps as u64) / 10_000;
let seller_fee = (matched_qty    * fee_rate_bps as u64) / 10_000;
```

These are accumulated into the batch `FeeAccumulator` rather than immediately creating per-match fee notes.

---

### 2.4 `programs/vault/src/instructions/tee_settle.rs`

The `note_fee_commitment` parameter (introduced in 1.3 above) carries the batch-level fee note:

- It is `Some` only on the last settlement call in a batch (or when the TEE decides to flush accumulated fees)
- The fee note commitment is computed over the batch's total accumulated fees for that token
- If `note_fee_commitment` is `Some`, the vault inserts it into the Merkle tree as any other note
- The vault does NOT independently verify the fee amount — it trusts the TEE-signed `match_result` fee fields for per-match conservation and trusts the batch-level fee accumulation is correct because it is inside the TEE

Note: in practice, `tee_forced_settle` is called once per match, not once per batch. The fee note is attached only to the last settlement transaction in a batch. The TEE knows this because it is the one scheduling the batch. For simplicity in v1, attach the fee note to the first settlement in each batch rather than the last to avoid needing to predict which match will be last.

---

## Tests to Add

All tests use litesvm unless otherwise noted.

---

### Partial fill re-lock tests

```
test_partial_fill_relocks_change_note
  Setup: Alice deposits 100 USDC. Buyer order for 50 USDC worth.
         Only 30 USDC worth matches in first batch.
  Action: tee_forced_settle with note_e = Some(change_note),
          buyer_relock_order_id = Some(order_id),
          buyer_relock_expiry = Some(current_slot + 43200).
  Assert:
    - C(note_A) is in consumed_notes
    - C(note_C) is in Merkle tree (30 USDC worth of SOL)
    - C(note_E) is in Merkle tree (70 USDC change)
    - NoteLocks PDA exists for C(note_E) with correct order_id and expiry
    - Alice's order in CLOB has collateral_note == C(note_E)
    - Alice's order remaining_quantity == original_quantity - 30_USDC_worth

test_partial_fill_second_batch_settles_via_change_note
  Continuing from test_partial_fill_relocks_change_note:
  Action: Second batch matches remaining 20 USDC worth using C(note_E) as collateral.
          tee_forced_settle with note_B = C(note_E), change = Some(50 USDC remainder).
  Assert:
    - C(note_E) is in consumed_notes
    - C(note_C2) in Merkle tree (Alice's second SOL batch)
    - C(note_E2) in Merkle tree (Alice's 50 USDC final change)
    - No active lock PDA for Alice's order (order fully consumed or cancelled)
    - Total SOL received == 30 USDC_worth + 20 USDC_worth (across both settlements)
    - Total change returned == 50 USDC
    - vault_balance conserved across both transactions

test_relock_without_change_note_returns_error
  Action: tee_forced_settle called with buyer_relock_order_id = Some(x)
          but note_e_commitment = None.
  Assert: Returns ErrorCode::RelockRequiresChangeNote. No state changes.

test_relock_expiry_releases_continuing_order
  Setup: Partial fill re-lock active with expiry_slot = N.
  Action: Advance to slot N+1 without second fill. Call release_lock(C(note_E)).
  Assert:
    - NoteLocks PDA for C(note_E) is deleted
    - C(note_E) is now spendable (withdrawal with valid VALID_SPEND proof succeeds)
    - CLOB order is effectively dead (matching engine should drain it as expired)

test_order_near_expiry_excluded_from_matching
  Setup: Order with expiry_slot = current_slot + 15 (below SETTLEMENT_BUFFER_SLOTS=20).
  Action: run_batch executes.
  Assert:
    - Order is not included in any match
    - Order is drained from CLOB
    - Note lock for that order is released

test_partial_fill_collateral_note_updated_in_clob
  After partial fill and re-lock:
  Assert: Order struct in CLOB has collateral_note == C(note_E), not C(note_A).

test_orphan_order_cannot_settle
  Simulate: Order in CLOB with collateral_note == C(note_A), but C(note_A)
            is in consumed_notes (simulates the old broken state).
  Action: Matching engine matches this orphan order. tee_forced_settle attempted.
  Assert: Returns ErrorCode::NoteAlreadyConsumed. No state changes. Counterparty's
          note lock must also be released (requires cleanup instruction).
```

---

### Fee note tests

```
test_fee_note_created_at_batch_end
  Setup: 3 matches in one batch, each with fee_rate 30bps.
  Action: Batch settles all 3. Fee accumulator flushes one fee note.
  Assert:
    - Exactly one fee note commitment inserted into Merkle tree for that token
    - fee_note.amount == sum(buyer_fee_amt + seller_fee_amt across all 3 matches)
    - Fee note owner_commitment == protocol_owner_commitment from VaultState

test_zero_fee_no_note_created
  Setup: match where matched_qty is so small that fee rounds to 0.
  Action: tee_forced_settle with note_fee_commitment = None.
  Assert: No extra commitment inserted. Merkle tree unchanged beyond trade outputs.

test_fee_note_spendable_by_protocol
  Setup: Protocol has Trading Key in Permission Group.
         Spending Key held in protocol HSM.
  Action: Protocol generates VALID_SPEND proof for fee note.
          Calls withdraw() with proof and destination = protocol_ata.
  Assert: Protocol receives fee tokens. Nullifier marked spent.

test_solvency_invariant_with_fees
  Setup: 10 matches across 3 batches. Variable amounts, all with fees.
  Assert: vault_token_balance == sum(all active note amounts) including fee notes.
  (This is the core solvency invariant — must hold with fees in scope.)

test_fee_note_wrong_owner_cannot_claim
  Action: Alice generates VALID_SPEND proof for the fee note
          (attempting to steal protocol fees).
  Assert: Proof fails at circuit level (owner_commitment mismatch).

test_fee_accumulator_resets_per_batch
  Setup: Batch 1 produces fee note of 500 lamports.
         Batch 2 produces fee note of 300 lamports.
  Assert: Each batch produces an independent fee note. They are not cumulative
          across batches. fee_accumulator.accumulated_fees == 0 at start of batch 2.

test_conservation_law_with_fees
  Action: tee_forced_settle where buyer_note_value != trade_notional
          + buyer_change_amt + buyer_fee_amt (deliberately wrong).
  Assert: Returns ErrorCode::ConservationViolation. No state changes.

test_fee_note_not_lockable
  Action: Attempt to call lock_note on a fee note commitment.
  Assert: Fails. Only the TEE (via its registered key) can call lock_note,
          and the TEE should never lock a fee note.
```

---

## Existing Tests to Update

```
test_tee_settle_atomic
  Update: Pass note_fee_commitment = None and both relock fields = None
  to preserve existing exact-fill no-fee semantics. Verify still passes.

test_tee_settle_replay_rejected
  Update: Ensure replay check fires before any Merkle insertions including
  fee note insertion. No change to logic, but re-verify assertion order.

test_vault_token_balance_invariant
  Update: Extend to include fee notes in the sum. The invariant is now:
  vault_balance == sum(user_notes) + sum(fee_notes_not_yet_withdrawn).
  Previous version only summed user notes — this would now fail if fee
  notes are present but not counted.

test_tee_settle_invalid_sig_rejected
  Update: Ensure test still passes with the expanded MatchResult struct
  containing fee and relock fields. No logic change needed.

test_full_trade_flow_e2e_devnet (E2E)
  Update: Assert that after settlement, the protocol's note storage
  contains a fee note for the batch. Assert that fee note is spendable
  by the protocol wallet. Assert Alice's order (if partial) has a
  re-locked change note rather than being orphaned.

test_both_sides_partial_returns_two_change_notes
  Update (from change_note_implementation.md): Add re-lock assertions.
  If both sides are partial fills, both change notes should have active
  lock PDAs pointing to their respective continuing orders.
```

---

## What Does NOT Change

- **`VALID_SPEND` circuit** — fee notes and re-locked change notes are standard notes. The circuit is unchanged.
- **`VALID_CREATE` circuit** — only validates trade output note amounts. Fee amounts are enforced by the conservation law in the vault program, not a circuit.
- **Note lock TTL mechanism** — re-locked change notes use the same lock/expiry mechanism as original order locks. No special case needed.
- **Nullifier scheme** — fee notes have nullifiers derived identically to any other note.
- **Indexer** — fee notes appear as standard note insertions in the Merkle tree. The indexer does not need to distinguish them.
