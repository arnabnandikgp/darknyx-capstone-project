/**
 * Deterministic (match_id, role) nonce / blinding — mirrors
 * `programs/matching_engine/src/state/change_note.rs` and
 * `packages/sdk/tests/helpers/e2e-helpers.ts`.
 *
 * TRADE_ROLE_* tags are test/demo relayer convention for note_c / note_d
 * (same SHA-256 domain as change notes, distinct role byte).
 */
import { createHash } from "node:crypto";

export const TRADE_ROLE_BUYER = 0xc1; // note_c (BASE → buyer)
export const TRADE_ROLE_SELLER = 0xd1; // note_d (QUOTE → seller)
export const FEE_ROLE_QUOTE = 0xfc;

export function deriveNonce(matchId: bigint, role: number): Uint8Array {
  const h = createHash("sha256");
  h.update(Buffer.from("nyx-change-nonce"));
  const mid = new Uint8Array(8);
  new DataView(mid.buffer).setBigUint64(0, matchId, true);
  h.update(mid);
  h.update(new Uint8Array([role]));
  const d = new Uint8Array(h.digest());
  d[0] = 0;
  d[1] &= 0x0f;
  return d;
}

export function deriveBlinding(matchId: bigint, role: number): Uint8Array {
  const h = createHash("sha256");
  h.update(Buffer.from("nyx-change-blind"));
  const mid = new Uint8Array(8);
  new DataView(mid.buffer).setBigUint64(0, matchId, true);
  h.update(mid);
  h.update(new Uint8Array([role]));
  const d = new Uint8Array(h.digest());
  d[0] = 0;
  d[1] &= 0x0f;
  return d;
}

export function be32ToBigInt(x: Uint8Array): bigint {
  let hex = "0x";
  for (const b of x) hex += b.toString(16).padStart(2, "0");
  return BigInt(hex);
}

/** Encode u64 match_id into the 16-byte `MatchResultPayload.match_id` field (matches devnet E2E tests). */
export function matchIdToPayloadBytes(matchId: bigint): Uint8Array {
  const out = new Uint8Array(16);
  new DataView(out.buffer).setBigUint64(8, matchId, true);
  return out;
}
