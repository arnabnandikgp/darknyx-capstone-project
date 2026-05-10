"use client";

import { useEffect, useState } from "react";

import { useDappContext } from "@/lib/dapp/dapp-context";
import { instructionFromJson, type InstructionJson } from "@/lib/dapp/ix-json";
import { readDappSession, type DappSessionV1 } from "@/lib/dapp/dapp-session";

type DepositTracking = {
  leafIndex: string;
  priorRightPathHex: string[];
  commitmentHex: string;
  nonce: string;
  blindingR: string;
  amount: string;
  side: "base" | "quote";
  tokenMintBase58: string;
};

type ReceiptLine = { label: string; signature: string };

type PanelStep = "idle" | "deposited" | "proving" | "withdrawn";

interface BalancesResponse {
  ok: boolean;
  error?: string;
  base?: { ata: string; exists: boolean; amount: string; mintBase58: string };
  quote?: { ata: string; exists: boolean; amount: string; mintBase58: string };
}

const DEFAULT_AMOUNT = process.env.NEXT_PUBLIC_DEMO_PRIVATE_AMOUNT ?? "10000";

function txUrl(sig: string) {
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}

function bytesToHex(b: Uint8Array): string {
  return Buffer.from(b).toString("hex");
}

export function PrivateDepositWithdrawPanel() {
  const { forwarder, getProver } = useDappContext();
  const [session, setSession] = useState<DappSessionV1 | null>(null);
  const [step, setStep] = useState<PanelStep>("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [side, setSide] = useState<"base" | "quote">("quote");
  const [amount, setAmount] = useState(DEFAULT_AMOUNT);
  const [tracking, setTracking] = useState<DepositTracking | null>(null);
  const [receipt, setReceipt] = useState<ReceiptLine[]>([]);
  const [proverMs, setProverMs] = useState<number | null>(null);
  const [balances, setBalances] = useState<BalancesResponse | null>(null);

  const fetchBalances = async (ownerPubkeyBase58: string) => {
    try {
      const res = await fetch("/api/dapp/balances", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ownerPubkeyBase58 }),
      });
      const json = (await res.json()) as BalancesResponse;
      setBalances(json);
    } catch (e) {
      setBalances({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  };

  useEffect(() => {
    // SSR renders this component with a null session; hydration on the client
    // then reads sessionStorage and re-renders. See the matching note in
    // dapp-trade-flow-panel.tsx — same hydration constraint applies here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSession(readDappSession());
    const s = readDappSession();
    if (s) {
      void fetchBalances(s.ownerPubkeyBase58);
    }
  }, []);

  const refresh = () => {
    setSession(readDappSession());
    const s = readDappSession();
    if (s) void fetchBalances(s.ownerPubkeyBase58);
  };

  const balanceForSide = (s: "base" | "quote"): bigint | null => {
    const b = s === "base" ? balances?.base : balances?.quote;
    if (!b) return null;
    try {
      return BigInt(b.amount);
    } catch {
      return null;
    }
  };

  const append = (lines: ReceiptLine[]) => setReceipt((r) => [...r, ...lines]);

  const runDeposit = async () => {
    const s = readDappSession();
    if (!s) throw new Error("Complete the identity step above first.");
    const want = (() => {
      try {
        return BigInt(amount || "0");
      } catch {
        return 0n;
      }
    })();
    if (want <= 0n) throw new Error("Amount must be a positive integer (raw u64 units).");
    const have = balanceForSide(side);
    if (have != null && want > have) {
      throw new Error(
        [
          `Amount ${want} exceeds your ${side.toUpperCase()} balance ${have}.`,
          "Lower the amount, or hit Refresh to retry the auto-airdrop.",
        ].join(" "),
      );
    }
    setBusy(true);
    setError(null);
    const res = await fetch("/api/dapp/private-deposit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        phantomSignatureBase58: s.phantomSignatureBase58,
        ownerPubkeyBase58: s.ownerPubkeyBase58,
        side,
        amount,
        nonce: (BigInt(Date.now()) + 7_777n).toString(),
      }),
    });
    const json = (await res.json()) as {
      ok?: boolean;
      error?: string;
      instructions?: InstructionJson[];
      tracking?: DepositTracking;
    };
    if (!res.ok || !json.ok || !json.instructions?.length || !json.tracking) {
      throw new Error(json.error ?? `HTTP ${res.status}`);
    }
    const ixs = json.instructions.map(instructionFromJson);
    const sig = await forwarder.sendAndConfirm(ixs);
    append([{ label: `private deposit (${side})`, signature: sig }]);
    setTracking(json.tracking);
    setStep("deposited");
    setBusy(false);
    void fetchBalances(s.ownerPubkeyBase58);
  };

  const runWithdraw = async () => {
    const s = readDappSession();
    if (!s) throw new Error("Session expired — re-derive your identity above.");
    if (!tracking) throw new Error("Run the deposit step first.");
    setBusy(true);
    setError(null);

    const prep = await fetch("/api/dapp/withdraw-prepare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        phantomSignatureBase58: s.phantomSignatureBase58,
        ownerPubkeyBase58: s.ownerPubkeyBase58,
        tokenMintBase58: tracking.tokenMintBase58,
        amount: tracking.amount,
        nonce: tracking.nonce,
        blindingR: tracking.blindingR,
        leafIndex: tracking.leafIndex,
        priorRightPathHex: tracking.priorRightPathHex,
      }),
    });
    const prepJson = (await prep.json()) as {
      ok?: boolean;
      error?: string;
      proverInputs?: {
        merkleRoot: string;
        nullifier: string;
        tokenMint: [string, string];
        amount: string;
        spendingKey: string;
        ownerCommitmentBlinding: string;
        nonce: string;
        blindingR: string;
        merklePath: string[];
        merkleIndices: string[];
      };
      ixContext?: {
        commitmentHex: string;
        nullifierHex: string;
        merkleRootHex: string;
      };
    };
    if (!prep.ok || !prepJson.ok || !prepJson.proverInputs || !prepJson.ixContext) {
      throw new Error(prepJson.error ?? `HTTP ${prep.status}`);
    }

    setStep("proving");
    const start = performance.now();
    const proof = await getProver().spend.prove({
      merkleRoot: BigInt(prepJson.proverInputs.merkleRoot),
      nullifier: BigInt(prepJson.proverInputs.nullifier),
      tokenMint: [
        BigInt(prepJson.proverInputs.tokenMint[0]),
        BigInt(prepJson.proverInputs.tokenMint[1]),
      ],
      amount: BigInt(prepJson.proverInputs.amount),
      spendingKey: BigInt(prepJson.proverInputs.spendingKey),
      ownerCommitmentBlinding: BigInt(prepJson.proverInputs.ownerCommitmentBlinding),
      nonce: BigInt(prepJson.proverInputs.nonce),
      blindingR: BigInt(prepJson.proverInputs.blindingR),
      merklePath: prepJson.proverInputs.merklePath.map((p) => BigInt(p)),
      merkleIndices: prepJson.proverInputs.merkleIndices.map((i) => Number(i)),
    });
    setProverMs(Math.round(performance.now() - start));

    const fin = await fetch("/api/dapp/withdraw-finalize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        phantomSignatureBase58: s.phantomSignatureBase58,
        ownerPubkeyBase58: s.ownerPubkeyBase58,
        tokenMintBase58: tracking.tokenMintBase58,
        amount: tracking.amount,
        commitmentHex: prepJson.ixContext.commitmentHex,
        nullifierHex: prepJson.ixContext.nullifierHex,
        merkleRootHex: prepJson.ixContext.merkleRootHex,
        proof: {
          piA: bytesToHex(proof.piA),
          piB: bytesToHex(proof.piB),
          piC: bytesToHex(proof.piC),
        },
      }),
    });
    const finJson = (await fin.json()) as {
      ok?: boolean;
      error?: string;
      instruction?: InstructionJson;
    };
    if (!fin.ok || !finJson.ok || !finJson.instruction) {
      throw new Error(finJson.error ?? `HTTP ${fin.status}`);
    }
    const sig = await forwarder.sendAndConfirm([instructionFromJson(finJson.instruction)]);
    append([{ label: `withdraw via VALID_SPEND (${side})`, signature: sig }]);
    setStep("withdrawn");
    setBusy(false);
  };

  const onClick = async () => {
    try {
      refresh();
      if (!readDappSession()) return;
      if (step === "idle") await runDeposit();
      else if (step === "deposited") await runWithdraw();
    } catch (e) {
      let msg = e instanceof Error ? e.message : String(e);
      if (/insufficient funds/i.test(msg)) {
        msg += [
          "",
          "This is your SPL token balance, not the Merkle tree.",
          "Amount is in raw smallest units (same as on-chain u64).",
          "Lower the amount or use Re-derive in the identity panel to mint more BASE/QUOTE.",
        ].join("\n");
      }
      setError(msg);
      setBusy(false);
    }
  };

  const reset = () => {
    setTracking(null);
    setStep("idle");
    setReceipt([]);
    setError(null);
    setProverMs(null);
  };

  const s0 = session ?? readDappSession();
  const label =
    step === "idle"
      ? "Private deposit"
      : step === "deposited"
        ? "Withdraw via VALID_SPEND"
        : step === "proving"
          ? "Proving in browser…"
          : "Done";

  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-zinc-900">Private deposit / withdraw</h2>
          <p className="mt-1 max-w-xl text-xs text-zinc-600">
            End-to-end privacy primitive: deposit a shielded note, then later prove ownership and
            withdraw it via a <code className="mx-1 rounded bg-zinc-100 px-1">VALID_SPEND</code>
            Groth16 proof. The proof runs <span className="font-semibold">in your browser</span>{" "}
            (snarkjs in a Web Worker), the Merkle witness is reconstructed from the
            <code className="mx-1 rounded bg-zinc-100 px-1">right_path</code> snapshot taken at
            deposit time. The identity step above auto-airdrops BASE + QUOTE so this panel
            should always have funds — if not, click <em>Refresh</em> to pull a fresh balance.
            Run withdraw <em>before</em>{" "}
            <code className="mx-1 rounded bg-zinc-100 px-1">submit_order</code> /{" "}
            <code className="mx-1 rounded bg-zinc-100 px-1">run_batch</code> — those append
            additional leaves and break the &ldquo;your note is the latest leaf&rdquo; invariant.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={refresh}
            className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-xs font-semibold text-zinc-700 hover:bg-zinc-50"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={reset}
            className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-xs font-semibold text-zinc-700 hover:bg-zinc-50"
          >
            Reset
          </button>
        </div>
      </div>

      {!s0 ? (
        <p className="text-sm text-zinc-600">Finish the identity step above — session will appear here.</p>
      ) : (
        <>
          <div className="mb-3 grid grid-cols-1 gap-2 text-[11px] text-zinc-700 sm:grid-cols-2">
            <div className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2">
              <div className="font-mono uppercase tracking-wide text-[10px] text-zinc-500">
                BASE balance
              </div>
              <div className="mt-0.5 font-mono">
                {balances?.base?.amount ?? "?"}
                {balances?.base && !balances.base.exists ? (
                  <span className="ml-2 text-amber-700">(no ATA yet)</span>
                ) : null}
              </div>
            </div>
            <div className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2">
              <div className="font-mono uppercase tracking-wide text-[10px] text-zinc-500">
                QUOTE balance
              </div>
              <div className="mt-0.5 font-mono">
                {balances?.quote?.amount ?? "?"}
                {balances?.quote && !balances.quote.exists ? (
                  <span className="ml-2 text-amber-700">(no ATA yet)</span>
                ) : null}
              </div>
            </div>
            {balances && !balances.ok ? (
              <div className="sm:col-span-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-red-800">
                balance lookup failed: {balances.error}
              </div>
            ) : null}
          </div>

          <div className="mb-4 flex flex-wrap items-end gap-3">
            <label className="text-xs text-zinc-600">
              Side
              <select
                className="ml-2 rounded border border-zinc-300 px-2 py-1 font-mono text-sm"
                value={side}
                onChange={(e) => setSide(e.target.value as "base" | "quote")}
                disabled={step !== "idle"}
              >
                <option value="quote">QUOTE</option>
                <option value="base">BASE</option>
              </select>
            </label>
            <label className="text-xs text-zinc-600">
              Amount
              <input
                className="ml-2 w-32 rounded border border-zinc-300 px-2 py-1 font-mono text-sm"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                disabled={step !== "idle"}
              />
            </label>
            <span className="max-w-xs text-[11px] leading-snug text-zinc-500">
              Raw smallest units (on-chain u64), not wallet UI &ldquo;tokens&rdquo;. Must be ≤ your
              SPL balance after airdrop (e.g. 10&nbsp;000 is safe for small test balances).
            </span>
          </div>

          {tracking ? (
            <div className="mb-3 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-[11px] text-zinc-700">
              <div>
                leaf <span className="font-mono">{tracking.leafIndex}</span> · note commitment
              </div>
              <div className="mt-0.5 truncate font-mono text-zinc-500" title={tracking.commitmentHex}>
                {tracking.commitmentHex.slice(0, 32)}…{tracking.commitmentHex.slice(-12)}
              </div>
            </div>
          ) : null}

          {proverMs != null ? (
            <p className="mb-2 text-[11px] text-zinc-500">
              VALID_SPEND proof generated in <span className="font-mono">{proverMs} ms</span> (browser)
            </p>
          ) : null}

          <button
            type="button"
            disabled={busy || step === "withdrawn" || step === "proving"}
            onClick={() => void onClick()}
            className="rounded-md bg-indigo-700 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-white hover:bg-indigo-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Working…" : label}
          </button>

          {error ? (
            <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
              {error}
            </div>
          ) : null}

          {step === "withdrawn" ? (
            <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
              <span className="font-semibold">Withdraw confirmed.</span> Your shielded note has been
              spent — the on-chain nullifier PDA is now created so the same note can never be
              double-spent.
            </div>
          ) : null}

          {receipt.length > 0 ? (
            <div className="mt-5">
              <h3 className="text-sm font-semibold text-zinc-900">Receipt</h3>
              <ul className="mt-2 space-y-1 text-xs">
                {receipt.map((r, i) => (
                  <li key={`${r.signature}-${i}`} className="font-mono text-zinc-700">
                    <span className="text-zinc-500">{r.label}</span> ·{" "}
                    <a
                      className="text-blue-600 hover:underline"
                      href={txUrl(r.signature)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {r.signature.slice(0, 10)}…
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
