//! `PendingOrder` — per-(user, market, slot_idx) order intent slot.
//!
//! Privacy property: this PDA is created on L1 EMPTY (status = Empty,
//! all order fields zeroed), then immediately delegated to the
//! MagicBlock ER validator. From that point on the slot is only
//! mutated INSIDE the ER session — `submit_order` writes order
//! intent (side / amount / price / note_commitment / ...) directly
//! into the delegated slot via the authenticated PER RPC. The plain
//! transaction data stays inside the TEE; L1 sees no order-intent
//! transaction at all.
//!
//! Matching (run_batch) reads all PendingOrder slots inside the ER,
//! produces MatchResults, and rotates partially-filled slots'
//! `collateral_note` + `note_amount` to the buyer/seller change-note
//! commitments. Filled / expired / cancelled slots are reset to Empty
//! so the user can reuse the slot for a future order without paying
//! re-allocation rent.
//!
//! Only the L1 commit of `BatchResults` ever surfaces aggregate
//! information; PendingOrder PDAs stay delegated indefinitely so
//! their content never lands on L1.

use anchor_lang::prelude::*;

pub const PENDING_ORDER_SEED: &[u8] = b"pending_order";

/// Up to MAX_PENDING_SLOTS_PER_USER concurrent orders per (user, market).
/// Each slot is a separate PDA — keeps each delegation independent and
/// allows partial-fill state on slot N while slot N+1 is still empty.
pub const MAX_PENDING_SLOTS_PER_USER: u8 = 4;

pub const PENDING_STATUS_EMPTY: u8 = 0;
pub const PENDING_STATUS_PENDING: u8 = 1;
pub const PENDING_STATUS_MATCHED: u8 = 2;
pub const PENDING_STATUS_EXPIRED: u8 = 3;
pub const PENDING_STATUS_CANCELLED: u8 = 4;

pub const PENDING_SIDE_BID: u8 = 0;
pub const PENDING_SIDE_ASK: u8 = 1;

pub const PENDING_TYPE_LIMIT: u8 = 0;
pub const PENDING_TYPE_IOC: u8 = 1;
pub const PENDING_TYPE_FOK: u8 = 2;

#[account(zero_copy)]
#[repr(C)]
#[derive(Default)]
pub struct PendingOrder {
    /// Owner trading key — Anchor's `Signer<'info>` constraint on
    /// `submit_order` enforces only this key can ever write the slot.
    pub trading_key: Pubkey,
    /// Market this slot is bound to (seed component).
    pub market: Pubkey,

    /// Status (see PENDING_STATUS_* consts).
    pub status: u8,
    /// 0 = bid (buy), 1 = ask (sell).
    pub side: u8,
    /// 0 = LIMIT, 1 = IOC, 2 = FOK.
    pub order_type: u8,
    /// Slot index (0..MAX_PENDING_SLOTS_PER_USER) — seed component.
    pub slot_idx: u8,
    pub bump: u8,
    pub _padding_a: [u8; 3],

    /// Filled in by `submit_order` — Solana slot at which order was written.
    /// Used as the matching tie-break (older first within equal price).
    pub arrival_slot: u64,
    /// Slot at which the order auto-expires.
    pub expiry_slot: u64,

    /// Limit price in tick units.
    pub price_limit: u64,
    /// Remaining order size (base units). Decremented on each partial fill.
    pub amount: u64,
    /// Original full order size — frozen at submit time.
    pub total_quantity: u64,
    /// Cumulative filled qty across all partial fills.
    pub filled_quantity: u64,
    /// Minimum fill qty (base units). 0 = any partial allowed.
    pub min_fill_qty: u64,
    /// Full value of the note CURRENTLY locked as collateral. Rotates to
    /// the change-note value on each partial-fill re-lock. BUY orders:
    /// QUOTE units; SELL orders: BASE units.
    pub note_amount: u64,

    /// Poseidon commitment of the note collateralising this order.
    pub collateral_note: [u8; 32],
    /// Owner commitment (= Poseidon(spending_key, r_owner)) — used to
    /// derive change-note commitments back to the same owner.
    pub user_commitment: [u8; 32],
    /// Caller-supplied 16-byte client id — used to derive NoteLock PDA at
    /// settle time + for cancel-by-id lookups.
    pub order_id: [u8; 16],
    pub _padding_b: [u8; 8],
    /// `SHA-256(arrival_slot || collateral_note_at_submit || trading_key)`.
    /// Anchored at submit time, never rotated. Used by the inclusion-root
    /// audit log so users can prove the TEE accepted their order.
    pub order_inclusion_commitment: [u8; 32],
}

impl PendingOrder {
    pub const SEED: &'static [u8] = PENDING_ORDER_SEED;

    /// Derive the PDA for (program_id, market, trading_key, slot_idx).
    pub fn pda(
        program_id: &Pubkey,
        market: &Pubkey,
        trading_key: &Pubkey,
        slot_idx: u8,
    ) -> (Pubkey, u8) {
        Pubkey::find_program_address(
            &[
                Self::SEED,
                market.as_ref(),
                trading_key.as_ref(),
                core::slice::from_ref(&slot_idx),
            ],
            program_id,
        )
    }

    /// Reset to Empty preserving identity + bump.
    pub fn clear(&mut self) {
        let trading_key = self.trading_key;
        let market = self.market;
        let slot_idx = self.slot_idx;
        let bump = self.bump;
        *self = Self::default();
        self.trading_key = trading_key;
        self.market = market;
        self.slot_idx = slot_idx;
        self.bump = bump;
        self.status = PENDING_STATUS_EMPTY;
    }
}
