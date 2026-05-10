/**
 * /api/dapp/prover-fixture — deterministic VALID_WALLET_CREATE witness fixture.
 *
 * The browser-side `WebProverSuite` uses this endpoint to smoke-test that the
 * worker boots, fetches circuit assets, generates a Groth16 proof, and that
 * the resulting public input matches the user commitment computed server-side.
 *
 * Why is this server-side rather than browser-side?
 *
 * The SDK's key derivation (`packages/sdk/src/keys/key-generators.ts`) uses
 * `node:crypto` (HKDF + KMAC256). We don't want to ship a parallel browser
 * implementation just for the smoke test. The full flow will instead use
 * Phantom-signed master seeds → server derives keys + circuit inputs → browser
 * proves + signs + sends.
 *
 * The fixture mirrors `packages/sdk/tests/helpers/snarkjs-prover.test.ts` so
 * we can compare results byte-for-byte against the existing CLI prover path.
 */

import {
  deriveMasterViewingKey,
  deriveSpendingKey,
  userCommitmentFromKeys,
} from "@nyx/sdk";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

function fixedSeed(): Uint8Array {
  const seed = new Uint8Array(64);
  for (let i = 0; i < 64; i++) seed[i] = (i * 7) & 0xff;
  return seed;
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function bytesToBigInt(b: Uint8Array): bigint {
  return BigInt("0x" + bytesToHex(b));
}

export async function GET() {
  try {
    const seed = fixedSeed();
    const sk = deriveSpendingKey(seed);
    const vk = deriveMasterViewingKey(seed);

    // Pick a deterministic root-key pubkey so this is offline-reproducible.
    const rootKeyPubkey = new Uint8Array(32);
    rootKeyPubkey[0] = 0x11;

    const r0 = 1n;
    const r1 = 2n;
    const r2 = 3n;

    const ucBytes = await userCommitmentFromKeys({
      rootKeyPubkey,
      spendingKey: sk,
      viewingKey: vk,
      r0,
      r1,
      r2,
    });

    // Split rootKey into (lo, hi) — the circuit takes [lo_u128, hi_u128].
    // Note: the SDK helper packs the upper 16 bytes as `hi` and lower 16 as
    // `lo` (mirrors `pubkeyToFrPair`).
    const hi = bytesToBigInt(rootKeyPubkey.subarray(0, 16));
    const lo = bytesToBigInt(rootKeyPubkey.subarray(16, 32));
    const ucBigint = bytesToBigInt(ucBytes);

    return NextResponse.json({
      ok: true,
      inputs: {
        userCommitment: ucBigint.toString(),
        rootKey: [lo.toString(), hi.toString()],
        spendingKey: sk.toString(),
        viewingKey: vk.toString(),
        r0: r0.toString(),
        r1: r1.toString(),
        r2: r2.toString(),
      },
      expected: {
        userCommitmentHex: bytesToHex(ucBytes),
        userCommitmentDecimal: ucBigint.toString(),
      },
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
