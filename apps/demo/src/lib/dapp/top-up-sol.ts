import type { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";

/** Ensure `recipient` has at least `minSol` SOL for rent + tx fees (default 0.06). */
export async function topUpSol(
  l1: Connection,
  funder: Keypair,
  recipient: PublicKey,
  minSol = 0.06,
): Promise<void> {
  const minLamports = Math.floor(minSol * LAMPORTS_PER_SOL);
  const current = await l1.getBalance(recipient, "confirmed");
  if (current >= minLamports) return;
  const delta = minLamports - current;
  await sendAndConfirmTransaction(
    l1,
    new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: funder.publicKey,
        toPubkey: recipient,
        lamports: delta,
      }),
    ),
    [funder],
    { commitment: "confirmed" },
  );
}
