/**
 * getOrderSubmitFunction — privacy-fix submit_order pipeline.
 *
 * Submit an order INSIDE the MagicBlock Ephemeral Rollup. The order's
 * `side`, `amount`, `price_limit`, `note_commitment` and `user_commitment`
 * never appear in any L1 log — they live and die inside the TEE unless
 * the order matches in `run_batch`.
 *
 * Pre-condition: the user's `PendingOrder` slot at `(market, slotIdx)` must
 * already be created on L1 (`init_pending_order_slot`) AND delegated to
 * the ER (`delegate_pending_order`) before this function is called.
 *
 * Stages (each throws DarkPoolError with its own `stage` tag):
 *   1. "parameter"           — synchronous arg validation.
 *   2. "attestation-verify"  — non-retryable PER attestation check.
 *   3. "auth-token-fetch"    — fetch/refresh JWT.
 *   4. "instruction-build"   — pure local; ix targets the delegated slot.
 *   5. "transaction-send"    — POST signed tx via PER session manager
 *                              (which routes to the ER RPC, NOT L1).
 */

import type { PublicKey, TransactionSignature } from "@solana/web3.js";

import type { DarkPoolClient } from "../client.js";
import { DarkPoolError } from "../errors.js";
import type { IPerSessionManager } from "../per/session-manager.js";
import {
  buildSubmitOrderInstruction,
  MAX_PENDING_SLOTS_PER_USER,
  OrderType,
  type SubmitOrderIxAndKeys,
} from "../idl/matching-engine-client.js";

export type OrderSide = "bid" | "ask";

/** Literal aliases for OrderType — lets SDK callers write "limit" | "ioc" | "fok". */
export type OrderTypeName = "limit" | "ioc" | "fok";

export interface OrderParams {
  /** The Trading Key that signs the submit_order tx. */
  tradingKey: PublicKey;
  /** The market this order belongs to. */
  market: PublicKey;
  /** Slot index (0..MAX_PENDING_SLOTS_PER_USER) — must be pre-allocated + delegated. */
  slotIdx: number;
  /** User commitment this trading key is tied to. */
  userCommitment: Uint8Array;
  /** 32-byte commitment of the note being collateralised. */
  noteCommitment: Uint8Array;
  /** Amount (base units) of the token the user wants to trade. */
  amount: bigint;
  /** Max price (bid) / min price (ask) the user accepts. */
  priceLimit: bigint;
  side: OrderSide;
  /** Value encoded in the note. Caller-supplied ceiling for notional check. */
  noteAmount: bigint;
  /** Slot at which the order auto-expires. */
  expirySlot: bigint;
  /** 16-byte random order id. */
  orderId: Uint8Array;
  /** LIMIT (rest in book), IOC (cancel unfilled remainder immediately),
   *  FOK (fill-or-kill). Defaults to LIMIT. */
  orderType?: OrderTypeName;
  /** Minimum fill qty in base units. 0 allows any partial fill. Defaults to 0. */
  minFillQty?: bigint;
}

const ORDER_TYPE_BY_NAME: Record<OrderTypeName, OrderType> = {
  limit: OrderType.Limit,
  ioc: OrderType.IOC,
  fok: OrderType.FOK,
};

export interface OrderReceipt {
  signature: TransactionSignature;
  pendingOrderPda: PublicKey;
}

export interface OrderSubmitDeps {
  perSessionManager: IPerSessionManager;
}

export type OrderSubmitFn = (params: OrderParams) => Promise<OrderReceipt>;

export function getOrderSubmitFunction(
  { client }: { client: DarkPoolClient },
  deps: OrderSubmitDeps,
): OrderSubmitFn {
  if (!client.matchingEngineProgramId) {
    throw new DarkPoolError(
      "parameter",
      "DarkPoolClient.matchingEngineProgramId must be set for order submission",
    );
  }
  const meProgramId = client.matchingEngineProgramId;

  return async (params): Promise<OrderReceipt> => {
    // ----- Parameter validation (synchronous / no IO) -----
    if (params.noteCommitment.length !== 32) {
      throw new DarkPoolError("parameter", "noteCommitment must be 32 bytes");
    }
    if (params.userCommitment.length !== 32) {
      throw new DarkPoolError("parameter", "userCommitment must be 32 bytes");
    }
    if (params.orderId.length !== 16) {
      throw new DarkPoolError("parameter", "orderId must be 16 bytes");
    }
    if (params.amount <= 0n) {
      throw new DarkPoolError("parameter", "amount must be > 0");
    }
    if (params.priceLimit <= 0n) {
      throw new DarkPoolError("parameter", "priceLimit must be > 0");
    }
    if (
      params.slotIdx < 0 ||
      params.slotIdx >= MAX_PENDING_SLOTS_PER_USER
    ) {
      throw new DarkPoolError(
        "parameter",
        `slotIdx must be in [0, ${MAX_PENDING_SLOTS_PER_USER})`,
      );
    }
    const notional = params.amount * params.priceLimit;
    if (notional > params.noteAmount) {
      throw new DarkPoolError(
        "parameter",
        "notional (amount * priceLimit) exceeds noteAmount",
      );
    }
    const minFillQty = params.minFillQty ?? 0n;
    if (minFillQty < 0n) {
      throw new DarkPoolError("parameter", "minFillQty must be >= 0");
    }
    if (minFillQty > params.amount) {
      throw new DarkPoolError("parameter", "minFillQty must be <= amount");
    }

    // ----- Stage 1: attestation-verify -----
    const attestOk = await deps.perSessionManager.verifyAttestation();
    if (!attestOk) {
      throw new DarkPoolError(
        "attestation-verify",
        "TEE attestation failed — no order data sent",
      );
    }

    // ----- Stage 2: auth-token-fetch -----
    let jwt: string;
    try {
      jwt = await deps.perSessionManager.getToken();
    } catch (err) {
      if (err instanceof DarkPoolError) throw err;
      throw new DarkPoolError(
        "auth-token-fetch",
        `getToken failed: ${String(err)}`,
      );
    }

    // ----- Stage 3: instruction-build -----
    let built: SubmitOrderIxAndKeys;
    try {
      built = buildSubmitOrderInstruction({
        programId: meProgramId,
        tradingKey: params.tradingKey,
        market: params.market,
        slotIdx: params.slotIdx,
        userCommitment: params.userCommitment,
        noteCommitment: params.noteCommitment,
        amount: params.amount,
        priceLimit: params.priceLimit,
        side: params.side === "bid" ? 0 : 1,
        noteAmount: params.noteAmount,
        expirySlot: params.expirySlot,
        orderId: params.orderId,
        orderType: ORDER_TYPE_BY_NAME[params.orderType ?? "limit"],
        minFillQty,
      });
    } catch (err) {
      throw new DarkPoolError(
        "instruction-build",
        `instruction build failed: ${String(err)}`,
      );
    }

    // ----- Stage 4: transaction-send (with one 401 refresh retry) -----
    const ctx = { traderPubkey: params.tradingKey.toBytes() };
    let signature: TransactionSignature;
    try {
      signature = await deps.perSessionManager.sendInstruction(
        built.ix,
        jwt,
        ctx,
      );
    } catch (err) {
      if (err instanceof DarkPoolError && err.stage === "auth-token-fetch") {
        const jwt2 = await deps.perSessionManager.getToken();
        signature = await deps.perSessionManager.sendInstruction(
          built.ix,
          jwt2,
          ctx,
        );
      } else if (err instanceof DarkPoolError) {
        throw err;
      } else {
        throw new DarkPoolError(
          "transaction-send",
          `PER send failed: ${String(err)}`,
        );
      }
    }

    return {
      signature,
      pendingOrderPda: built.pendingOrderPda,
    };
  };
}
