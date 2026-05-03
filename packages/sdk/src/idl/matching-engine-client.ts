/**
 * Pure-TS instruction builder for the matching_engine program.
 *
 * Mirrors the style of `vault-client.ts`: Anchor discriminator (sha256
 * "global:<ix>")[0..8] ++ Borsh-encoded args. Fixed-size byte arrays are
 * emitted inline; Vec<T> carries a 4-byte length prefix.
 */

import { PublicKey, TransactionInstruction, SystemProgram } from "@solana/web3.js";
import { createHash } from "node:crypto";

import {
  BATCH_RESULTS_SEED,
  DARK_CLOB_SEED,
  MATCHING_CONFIG_SEED,
  PENDING_ORDER_SEED,
} from "./seeds.js";
import { vaultConfigPda, walletEntryPda, noteLockPda, consumedNotePda } from "./vault-client.js";

/** MagicBlock permission program id (see ephemeral-rollups-sdk consts). */
export const PERMISSION_PROGRAM_ID = new PublicKey(
  "ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1",
);

function anchorDiscriminator(name: string): Uint8Array {
  const h = createHash("sha256");
  h.update(`global:${name}`);
  return new Uint8Array(h.digest()).slice(0, 8);
}

function cat(...bs: Uint8Array[]): Uint8Array {
  const n = bs.reduce((s, b) => s + b.length, 0);
  const out = new Uint8Array(n);
  let off = 0;
  for (const b of bs) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}

function u64LE(v: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, v, true);
  return out;
}

function u32LE(v: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, v, true);
  return out;
}

function fixed32(x: Uint8Array): Uint8Array {
  if (x.length !== 32) throw new Error(`expected 32 bytes, got ${x.length}`);
  return x;
}

function fixed16(x: Uint8Array): Uint8Array {
  if (x.length !== 16) throw new Error(`expected 16 bytes, got ${x.length}`);
  return x;
}

export function darkClobPda(
  programId: PublicKey,
  market: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [DARK_CLOB_SEED, market.toBuffer()],
    programId,
  );
}

export function matchingConfigPda(
  programId: PublicKey,
  market: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [MATCHING_CONFIG_SEED, market.toBuffer()],
    programId,
  );
}

export function batchResultsPda(
  programId: PublicKey,
  market: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [BATCH_RESULTS_SEED, market.toBuffer()],
    programId,
  );
}

/**
 * `PendingOrder` PDA — one slot per (market, trading_key, slot_idx).
 * Mirrors `PendingOrder::pda()` in
 * `programs/matching_engine/src/state/pending_order.rs`.
 */
export function pendingOrderPda(
  programId: PublicKey,
  market: PublicKey,
  tradingKey: PublicKey,
  slotIdx: number,
): [PublicKey, number] {
  if (slotIdx < 0 || slotIdx > 255) {
    throw new Error(`slotIdx must be a u8 (0..255), got ${slotIdx}`);
  }
  return PublicKey.findProgramAddressSync(
    [
      PENDING_ORDER_SEED,
      market.toBuffer(),
      tradingKey.toBuffer(),
      Uint8Array.of(slotIdx),
    ],
    programId,
  );
}

/** Maximum concurrent pending orders per (user, market). Mirrors
 *  `MAX_PENDING_SLOTS_PER_USER` in pending_order.rs. */
export const MAX_PENDING_SLOTS_PER_USER = 4;

/** Order type enum mirroring `ORDER_TYPE_*` in the program. */
export enum OrderType {
  Limit = 0,
  IOC = 1,
  FOK = 2,
}

export interface BuildInitMarketParams {
  programId: PublicKey;
  vaultProgramId: PublicKey;
  payer: PublicKey;
  market: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  pythAccount: PublicKey;
  batchIntervalSlots: bigint;
  circuitBreakerBps: bigint;
  tickSize: bigint;
  minOrderSize: bigint;
}

export function buildInitMarketInstruction(
  p: BuildInitMarketParams,
): TransactionInstruction {
  const [vaultCfg] = vaultConfigPda(p.vaultProgramId);
  const [clobPda] = darkClobPda(p.programId, p.market);
  const [matchPda] = matchingConfigPda(p.programId, p.market);
  const [batchPda] = batchResultsPda(p.programId, p.market);
  const data = cat(
    anchorDiscriminator("init_market"),
    p.market.toBytes(),
    p.baseMint.toBytes(),
    p.quoteMint.toBytes(),
    p.pythAccount.toBytes(),
    u64LE(p.batchIntervalSlots),
    u64LE(p.circuitBreakerBps),
    u64LE(p.tickSize),
    u64LE(p.minOrderSize),
  );
  return new TransactionInstruction({
    programId: p.programId,
    keys: [
      { pubkey: p.payer, isSigner: true, isWritable: true },
      { pubkey: vaultCfg, isSigner: false, isWritable: false },
      { pubkey: clobPda, isSigner: false, isWritable: true },
      { pubkey: matchPda, isSigner: false, isWritable: true },
      { pubkey: batchPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

export interface MemberArgJson {
  flags: number;
  pubkey: PublicKey;
}

export interface BuildConfigureAccessParams {
  programId: PublicKey;
  rootKey: PublicKey;
  market: PublicKey;
  members: MemberArgJson[];
  isUpdate: boolean;
  /** Permission PDA (derived by MagicBlock from the DarkCLOB PDA). */
  permissionPda: PublicKey;
}

export function buildConfigureAccessInstruction(
  p: BuildConfigureAccessParams,
): TransactionInstruction {
  const [clobPda] = darkClobPda(p.programId, p.market);
  const [matchPda] = matchingConfigPda(p.programId, p.market);
  // Members vec serialisation: u32 length LE, then (u8 flags + 32 bytes pubkey) × N.
  const memberBytes: Uint8Array[] = [];
  for (const m of p.members) {
    memberBytes.push(new Uint8Array([m.flags]));
    memberBytes.push(m.pubkey.toBytes());
  }
  const data = cat(
    anchorDiscriminator("configure_access"),
    p.market.toBytes(),
    u32LE(p.members.length),
    ...memberBytes,
    new Uint8Array([p.isUpdate ? 1 : 0]),
  );
  return new TransactionInstruction({
    programId: p.programId,
    keys: [
      { pubkey: p.rootKey, isSigner: true, isWritable: true },
      { pubkey: clobPda, isSigner: false, isWritable: true },
      { pubkey: matchPda, isSigner: false, isWritable: false },
      { pubkey: p.permissionPda, isSigner: false, isWritable: true },
      { pubkey: PERMISSION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

// ---------------------------------------------------------------------------
// init_pending_order_slot (L1) + delegate_pending_order (L1)
// ---------------------------------------------------------------------------

export interface BuildInitPendingOrderSlotParams {
  programId: PublicKey;
  /** Owner trading key — fee-payer + only key allowed to write the slot. */
  tradingKey: PublicKey;
  market: PublicKey;
  /** 0..MAX_PENDING_SLOTS_PER_USER. */
  slotIdx: number;
}

export function buildInitPendingOrderSlotInstruction(
  p: BuildInitPendingOrderSlotParams,
): TransactionInstruction {
  if (p.slotIdx < 0 || p.slotIdx >= MAX_PENDING_SLOTS_PER_USER) {
    throw new Error(
      `slotIdx must be in [0, ${MAX_PENDING_SLOTS_PER_USER}); got ${p.slotIdx}`,
    );
  }
  const [pda] = pendingOrderPda(p.programId, p.market, p.tradingKey, p.slotIdx);
  const data = cat(
    anchorDiscriminator("init_pending_order_slot"),
    p.market.toBytes(),
    new Uint8Array([p.slotIdx]),
  );
  return new TransactionInstruction({
    programId: p.programId,
    keys: [
      { pubkey: p.tradingKey, isSigner: true, isWritable: true },
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

export interface BuildDelegatePendingOrderParams {
  programId: PublicKey;
  /** Pays delegation rent. Often the trading key itself; can be a separate funder. */
  payer: PublicKey;
  /** Trading key — second signer on the delegation tx, authorises hand-off. */
  tradingKey: PublicKey;
  market: PublicKey;
  slotIdx: number;
}

/**
 * Build a `delegate_pending_order` ix. Hands the slot PDA to the
 * MagicBlock ER validator. Wire order MUST mirror the `#[delegate]`
 * macro field-injection pattern. For DelegatePendingOrder { payer:
 * Signer, trading_key: Signer, pda: AccountInfo(del) }:
 *
 *   1. payer
 *   2. trading_key
 *   3. buffer_pda                <— injected by macro
 *   4. delegation_record         <— injected by macro
 *   5. delegation_metadata       <— injected by macro
 *   6. pda (the delegated slot)
 *   7. owner_program (matching_engine)
 *   8. delegation_program
 *   9. system_program
 */
export function buildDelegatePendingOrderInstruction(
  p: BuildDelegatePendingOrderParams,
): TransactionInstruction {
  if (p.slotIdx < 0 || p.slotIdx >= MAX_PENDING_SLOTS_PER_USER) {
    throw new Error(
      `slotIdx must be in [0, ${MAX_PENDING_SLOTS_PER_USER}); got ${p.slotIdx}`,
    );
  }
  const [pda] = pendingOrderPda(p.programId, p.market, p.tradingKey, p.slotIdx);

  const DELEGATION_PROGRAM_ID = new PublicKey(
    "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh",
  );
  const [bufferPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("buffer"), pda.toBuffer()],
    p.programId,
  );
  const [recordPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("delegation"), pda.toBuffer()],
    DELEGATION_PROGRAM_ID,
  );
  const [metadataPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("delegation-metadata"), pda.toBuffer()],
    DELEGATION_PROGRAM_ID,
  );

  const data = cat(
    anchorDiscriminator("delegate_pending_order"),
    p.market.toBytes(),
    new Uint8Array([p.slotIdx]),
  );

  return new TransactionInstruction({
    programId: p.programId,
    keys: [
      { pubkey: p.payer, isSigner: true, isWritable: true },
      { pubkey: p.tradingKey, isSigner: true, isWritable: false },
      { pubkey: bufferPda, isSigner: false, isWritable: true },
      { pubkey: recordPda, isSigner: false, isWritable: true },
      { pubkey: metadataPda, isSigner: false, isWritable: true },
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: p.programId, isSigner: false, isWritable: false },
      { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

// ---------------------------------------------------------------------------
// submit_order — privacy-fix shape. Single signer, single account write.
// Sent to the ER RPC; the slot must already be delegated.
// ---------------------------------------------------------------------------

export interface BuildSubmitOrderParams {
  programId: PublicKey;
  /** Trading key — single signer. Owns the slot via PDA seed. */
  tradingKey: PublicKey;
  market: PublicKey;
  /** 0..MAX_PENDING_SLOTS_PER_USER. */
  slotIdx: number;
  /** 0 = bid (buy), 1 = ask (sell). */
  side: number;
  amount: bigint;
  priceLimit: bigint;
  /** Full note value collateralising this order. */
  noteAmount: bigint;
  expirySlot: bigint;
  /** 16-byte client id; zero is rejected. */
  orderId: Uint8Array;
  noteCommitment: Uint8Array;
  /** Owner commitment tied to this trading key. */
  userCommitment: Uint8Array;
  orderType?: OrderType;
  minFillQty?: bigint;
}

export interface SubmitOrderIxAndKeys {
  ix: TransactionInstruction;
  /** PDA of the PendingOrder slot we wrote to. */
  pendingOrderPda: PublicKey;
}

export function buildSubmitOrderInstruction(
  p: BuildSubmitOrderParams,
): SubmitOrderIxAndKeys {
  if (p.slotIdx < 0 || p.slotIdx >= MAX_PENDING_SLOTS_PER_USER) {
    throw new Error(
      `slotIdx must be in [0, ${MAX_PENDING_SLOTS_PER_USER}); got ${p.slotIdx}`,
    );
  }
  if (p.side !== 0 && p.side !== 1) {
    throw new Error(`side must be 0 (bid) or 1 (ask); got ${p.side}`);
  }
  const [slotPda] = pendingOrderPda(
    p.programId,
    p.market,
    p.tradingKey,
    p.slotIdx,
  );

  // Borsh layout MUST match `SubmitOrderArgs` in
  // programs/matching_engine/src/instructions/submit_order.rs.
  const argsBytes = cat(
    p.market.toBytes(),
    new Uint8Array([p.slotIdx]),
    new Uint8Array([p.side]),
    new Uint8Array([p.orderType ?? OrderType.Limit]),
    new Uint8Array(5), // _padding
    u64LE(p.amount),
    u64LE(p.minFillQty ?? 0n),
    u64LE(p.priceLimit),
    u64LE(p.noteAmount),
    u64LE(p.expirySlot),
    fixed16(p.orderId),
    fixed32(p.noteCommitment),
    fixed32(p.userCommitment),
  );

  const data = cat(anchorDiscriminator("submit_order"), argsBytes);

  const ix = new TransactionInstruction({
    programId: p.programId,
    keys: [
      { pubkey: p.tradingKey, isSigner: true, isWritable: true },
      { pubkey: slotPda, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(data),
  });

  return { ix, pendingOrderPda: slotPda };
}

// ---------------------------------------------------------------------------
// cancel_order (privacy-fix shape — operates on a PendingOrder slot via slot_idx)
// ---------------------------------------------------------------------------

export interface BuildCancelOrderParams {
  programId: PublicKey;
  tradingKey: PublicKey;
  market: PublicKey;
  /** 0..MAX_PENDING_SLOTS_PER_USER. */
  slotIdx: number;
}

export function buildCancelOrderInstruction(
  p: BuildCancelOrderParams,
): TransactionInstruction {
  if (p.slotIdx < 0 || p.slotIdx >= MAX_PENDING_SLOTS_PER_USER) {
    throw new Error(
      `slotIdx must be in [0, ${MAX_PENDING_SLOTS_PER_USER}); got ${p.slotIdx}`,
    );
  }
  const [slotPda] = pendingOrderPda(
    p.programId,
    p.market,
    p.tradingKey,
    p.slotIdx,
  );
  const data = cat(
    anchorDiscriminator("cancel_order"),
    p.market.toBytes(),
    new Uint8Array([p.slotIdx]),
  );
  return new TransactionInstruction({
    programId: p.programId,
    keys: [
      { pubkey: p.tradingKey, isSigner: true, isWritable: true },
      { pubkey: slotPda, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(data),
  });
}

// ---------------------------------------------------------------------------
// run_batch (privacy-fix shape — PendingOrder PDAs supplied via remaining_accounts)
// ---------------------------------------------------------------------------

export interface BuildRunBatchParams {
  programId: PublicKey;
  /** Vault program id — needed to derive the cross-program vault_config PDA. */
  vaultProgramId: PublicKey;
  teeAuthority: PublicKey;
  market: PublicKey;
  pythAccount: PublicKey;
  /** PendingOrder PDAs participating in this auction. */
  pendingOrderPdas: PublicKey[];
}

export function buildRunBatchInstruction(
  p: BuildRunBatchParams,
): TransactionInstruction {
  const [matchPda] = matchingConfigPda(p.programId, p.market);
  const [batchPda] = batchResultsPda(p.programId, p.market);
  const [vaultCfg] = vaultConfigPda(p.vaultProgramId);
  const data = cat(anchorDiscriminator("run_batch"), p.market.toBytes());
  const keys = [
    { pubkey: p.teeAuthority, isSigner: true, isWritable: true },
    { pubkey: matchPda, isSigner: false, isWritable: false },
    { pubkey: batchPda, isSigner: false, isWritable: true },
    { pubkey: vaultCfg, isSigner: false, isWritable: false },
    { pubkey: p.pythAccount, isSigner: false, isWritable: false },
  ];
  for (const pda of p.pendingOrderPdas) {
    keys.push({ pubkey: pda, isSigner: false, isWritable: true });
  }
  return new TransactionInstruction({
    programId: p.programId,
    keys,
    data: Buffer.from(data),
  });
}

// ---------------------------------------------------------------------------
// init_mock_oracle (dev-net / test-only helper)
// ---------------------------------------------------------------------------

export interface BuildInitMockOracleParams {
  programId: PublicKey;
  payer: PublicKey;
  mockOracle: PublicKey;
  /** u64 TWAP written to bytes [8..16] of the mock oracle account. */
  twap: bigint;
}

/**
 * Create + initialise a 16-byte mock Pyth oracle account on devnet. The
 * returned ix MUST be preceded (same tx, different signer set) by a fresh
 * keypair signer for `mockOracle`. Total tx signers: [payer, mockOracle].
 *
 * Account layout written by the handler:
 *   [0..8]   b"NYXMKPTH" (MOCK_PYTH_MAGIC)
 *   [8..16]  u64 LE TWAP
 */
export function buildInitMockOracleInstruction(
  p: BuildInitMockOracleParams,
): TransactionInstruction {
  const data = cat(
    anchorDiscriminator("init_mock_oracle"),
    u64LE(p.twap),
  );
  return new TransactionInstruction({
    programId: p.programId,
    keys: [
      { pubkey: p.payer, isSigner: true, isWritable: true },
      { pubkey: p.mockOracle, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}
