"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Connection, Keypair, Transaction } from "@solana/web3.js";
import bs58 from "bs58";

import { useDappContext } from "@/lib/dapp/dapp-context";
import { instructionFromJson, type InstructionJson } from "@/lib/dapp/ix-json";
import { readDappSession, type DappSessionV1 } from "@/lib/dapp/dapp-session";

import { NYX_TRADE_WITHDRAW_KEY } from "@/lib/dapp/trade-withdraw-storage";

const ER_RPC = process.env.NEXT_PUBLIC_DEMO_ER_RPC_URL ?? "https://devnet.magicblock.app";
/**
 * `setup-devnet` provisions a mock oracle with TWAP = 100 and circuit_breaker_bps = 500
 * (5%). The clearing price must land inside [95, 105] or `run_batch` skips the match
 * with the circuit breaker tripped (and BatchResults.write_cursor stays at zero).
 * We default the exchange rate (and order price limit) to 100 to sit at the centre
 * of that band. Override with `NEXT_PUBLIC_DEMO_EXCHANGE_QUOTE_PER_BASE` if your
 * oracle is configured differently.
 */
const QUOTE_PER_BASE = BigInt(process.env.NEXT_PUBLIC_DEMO_EXCHANGE_QUOTE_PER_BASE ?? "100");
/** Bid `submit_order` requires `amount * price_limit <= note_amount` (on-chain MatchingError::NotionalExceedsNoteValue). Quote deposit is `base * QUOTE_PER_BASE`, so default the limit to the same peg unless overridden. */
const ORDER_PRICE_LIMIT =
  process.env.NEXT_PUBLIC_DEMO_ORDER_PRICE ?? QUOTE_PER_BASE.toString();

type FlowStep =
  | "idle"
  | "registered"
  | "slot_ready"
  | "deposited"
  | "order_er"
  | "matched";

interface ReceiptLine {
  label: string;
  signature: string;
  cluster: "l1" | "er";
}

function txUrl(sig: string) {
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}

export function DappTradeFlowPanel() {
  const { forwarder, connection: l1 } = useDappContext();
  const er = useMemo(() => new Connection(ER_RPC, "confirmed"), []);

  const [session, setSession] = useState<DappSessionV1 | null>(null);
  const [step, setStep] = useState<FlowStep>("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [slotIdx, setSlotIdx] = useState<number | null>(null);
  const [baseAmount, setBaseAmount] = useState("10");
  const [depositNonce] = useState(() => (BigInt(Date.now()) + 333_333n).toString());

  useEffect(() => {
    // SSR renders this component with a null session; hydration on the client
    // then reads sessionStorage and re-renders. setState here is intentional —
    // a lazy initializer would touch `sessionStorage` during SSR and crash, and
    // skipping the read would leave a logged-in user looking like a fresh one
    // until they touch the form.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSession(readDappSession());
  }, []);
  const [depositNote, setDepositNote] = useState<{
    commitmentHex: string;
    amount: string;
  } | null>(null);
  const orderCtxRef = useRef<{ orderIdHex: string; expirySlot: string } | null>(null);
  const [receipt, setReceipt] = useState<ReceiptLine[]>([]);

  const refreshSession = useCallback(() => {
    setSession(readDappSession());
  }, []);

  const appendReceipt = (lines: ReceiptLine[]) => {
    setReceipt((r) => [...r, ...lines]);
  };

  const runRegister = async () => {
    const s = readDappSession();
    if (!s) throw new Error("Complete the identity step above first.");
    setBusy(true);
    setError(null);
    const res = await fetch("/api/dapp/register-wallet", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        phantomSignatureBase58: s.phantomSignatureBase58,
        ownerPubkeyBase58: s.ownerPubkeyBase58,
        proof: s.proof,
      }),
    });
    const json = (await res.json()) as {
      ok?: boolean;
      error?: string;
      alreadyRegistered?: boolean;
      walletPdaBase58?: string;
      instruction?: InstructionJson;
    };
    if (!res.ok || !json.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
    if (json.alreadyRegistered) {
      appendReceipt([
        {
          label: `wallet already registered (PDA ${json.walletPdaBase58?.slice(0, 8) ?? ""}…)`,
          signature: "skipped",
          cluster: "l1",
        },
      ]);
    } else if (json.instruction) {
      const sig = await forwarder.sendAndConfirm([instructionFromJson(json.instruction)]);
      appendReceipt([{ label: "create_wallet (L1)", signature: sig, cluster: "l1" }]);
    } else {
      throw new Error("register-wallet: missing instruction in response");
    }
    setStep("registered");
    setBusy(false);
  };

  const runInitSlot = async () => {
    const s = readDappSession();
    if (!s) throw new Error("No session");
    setBusy(true);
    setError(null);
    const res = await fetch("/api/dapp/init-slot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        phantomSignatureBase58: s.phantomSignatureBase58,
        ownerPubkeyBase58: s.ownerPubkeyBase58,
        tradingSecretKeyBase58: s.tradingSecretKeyBase58,
      }),
    });
    const json = (await res.json()) as { ok?: boolean; slotIdx?: number; error?: string };
    if (!res.ok || !json.ok || json.slotIdx === undefined) throw new Error(json.error ?? `HTTP ${res.status}`);
    setSlotIdx(json.slotIdx);
    setStep("slot_ready");
    setBusy(false);
  };

  const runDeposit = async () => {
    const s = readDappSession();
    if (!s) throw new Error("No session");
    const base = BigInt(baseAmount || "0");
    if (base <= 0n) throw new Error("Base amount must be > 0");
    const quoteAmount = base * QUOTE_PER_BASE;
    const priceLim = BigInt(ORDER_PRICE_LIMIT);
    const bidNotional = base * priceLim;
    if (quoteAmount < bidNotional) {
      throw new Error(
        `Quote deposit (base×${QUOTE_PER_BASE}=${quoteAmount}) is smaller than bid notional (base×price_limit=${bidNotional}). ` +
          `Raise NEXT_PUBLIC_DEMO_EXCHANGE_QUOTE_PER_BASE or lower NEXT_PUBLIC_DEMO_ORDER_PRICE (see README).`,
      );
    }
    setBusy(true);
    setError(null);
    const res = await fetch("/api/dapp/deposit-prepare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        phantomSignatureBase58: s.phantomSignatureBase58,
        ownerPubkeyBase58: s.ownerPubkeyBase58,
        side: "quote",
        amount: quoteAmount.toString(),
        nonce: depositNonce,
      }),
    });
    const json = (await res.json()) as {
      ok?: boolean;
      instruction?: InstructionJson;
      preview?: { noteCommitmentHex: string };
      error?: string;
    };
    if (!res.ok || !json.ok || !json.instruction) throw new Error(json.error ?? `HTTP ${res.status}`);
    const sig = await forwarder.sendAndConfirm([instructionFromJson(json.instruction)]);
    appendReceipt([{ label: "deposit quote collateral (L1)", signature: sig, cluster: "l1" }]);
    setDepositNote({
      commitmentHex: json.preview?.noteCommitmentHex ?? "",
      amount: quoteAmount.toString(),
    });
    setStep("deposited");
    setBusy(false);
  };

  const runSubmitOrderEr = async () => {
    const s = readDappSession();
    if (!s || slotIdx == null || !depositNote?.commitmentHex) {
      throw new Error("Complete slot + deposit steps first.");
    }
    const base = BigInt(baseAmount || "0");
    const priceLim = BigInt(ORDER_PRICE_LIMIT || "0");
    const noteAmt = BigInt(depositNote.amount);
    const required = base * priceLim;
    if (required > noteAmt) {
      throw new Error(
        `Bid notional base×price_limit (${base}×${priceLim}=${required}) exceeds your quote note (${noteAmt}). ` +
          `Either lower base size / price_limit, or deposit more quote (note must cover amount×price_limit; on-chain code: MatchingError::NotionalExceedsNoteValue / 0x177a).`,
      );
    }
    setBusy(true);
    setError(null);
    const trading = Keypair.fromSecretKey(bs58.decode(s.tradingSecretKeyBase58));
    const now = await l1.getSlot("confirmed");
    const expiry = BigInt(now) + 500n;
    const orderId = crypto.getRandomValues(new Uint8Array(16));
    const orderIdHex = Buffer.from(orderId).toString("hex");
    orderCtxRef.current = { orderIdHex, expirySlot: expiry.toString() };

    const res = await fetch("/api/dapp/build-submit-order", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        phantomSignatureBase58: s.phantomSignatureBase58,
        ownerPubkeyBase58: s.ownerPubkeyBase58,
        tradingSecretKeyBase58: s.tradingSecretKeyBase58,
        slotIdx,
        side: 0,
        amount: baseAmount,
        priceLimit: ORDER_PRICE_LIMIT,
        noteAmount: depositNote.amount,
        expirySlot: expiry.toString(),
        noteCommitmentHex: depositNote.commitmentHex,
        userOwnerCommitmentHex: s.publicData.ownerCommitmentHex,
        orderIdHex,
      }),
    });
    const json = (await res.json()) as {
      ok?: boolean;
      instruction?: InstructionJson;
      error?: string;
    };
    if (!res.ok || !json.ok || !json.instruction) throw new Error(json.error ?? `HTTP ${res.status}`);
    const tx = new Transaction().add(instructionFromJson(json.instruction));
    const { blockhash, lastValidBlockHeight } = await er.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = trading.publicKey;
    tx.sign(trading);
    const sig = await er.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });
    await er.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    appendReceipt([{ label: "submit_order bid (ER)", signature: sig, cluster: "er" }]);
    setStep("order_er");
    setBusy(false);
  };

  const runCounterMatch = async () => {
    const s = readDappSession();
    if (!s || slotIdx == null) throw new Error("Missing slot");
    setBusy(true);
    setError(null);
    const ctx = orderCtxRef.current;
    if (!ctx?.orderIdHex || !ctx.expirySlot) {
      throw new Error("Internal: order id / expiry missing — submit_order step must run first.");
    }
    const res = await fetch("/api/dapp/counter-and-match", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        phantomSignatureBase58: s.phantomSignatureBase58,
        ownerPubkeyBase58: s.ownerPubkeyBase58,
        tradingSecretKeyBase58: s.tradingSecretKeyBase58,
        userSlotIdx: slotIdx,
        userSide: 0,
        userAmount: baseAmount,
        userPriceLimit: ORDER_PRICE_LIMIT,
        userNoteAmount: depositNote?.amount ?? "0",
        userNoteCommitmentHex: depositNote?.commitmentHex ?? "",
        userOwnerCommitmentHex: s.publicData.ownerCommitmentHex,
        userOrderIdHex: ctx.orderIdHex,
        userExpirySlot: ctx.expirySlot,
      }),
    });
    const json = (await res.json()) as {
      ok?: boolean;
      signatures?: ReceiptLine[];
      error?: string;
      tradeWithdrawBuyerBase?: {
        matchId: string;
        leafIndex: string;
        amount: string;
        nonce: string;
        blindingR: string;
        commitmentHex: string;
        tokenMintBase58: string;
        vaultLeafCountAfter: string;
      };
    };
    if (!res.ok || !json.ok || !json.signatures) throw new Error(json.error ?? `HTTP ${res.status}`);
    appendReceipt(json.signatures);
    if (json.tradeWithdrawBuyerBase) {
      try {
        sessionStorage.setItem(
          NYX_TRADE_WITHDRAW_KEY,
          JSON.stringify({
            tradeWithdrawBuyerBase: json.tradeWithdrawBuyerBase,
            ownerCommitmentHex: s.publicData.ownerCommitmentHex,
          }),
        );
      } catch {
        /* private mode */
      }
    }
    setStep("matched");
    setBusy(false);
  };

  const nextAction = async () => {
    try {
      refreshSession();
      if (!readDappSession()) return;
      if (step === "idle") await runRegister();
      else if (step === "registered") await runInitSlot();
      else if (step === "slot_ready") await runDeposit();
      else if (step === "deposited") await runSubmitOrderEr();
      else if (step === "order_er") await runCounterMatch();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const s0 = session ?? readDappSession();
  const label =
    step === "matched"
      ? "Done"
      : step === "idle"
        ? "Register wallet on-chain"
        : step === "registered"
          ? "Init + delegate ER slot"
          : step === "slot_ready"
            ? "Deposit quote collateral"
            : step === "deposited"
              ? "Submit bid on ER"
              : step === "order_er"
                ? "Counterparty + run_batch"
                : "Continue";

  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-zinc-900">Trade on devnet</h2>
          <p className="mt-1 max-w-xl text-xs text-zinc-600">
            Fixed rate:{" "}
            <span className="font-mono font-semibold text-zinc-800">1 BASE = {QUOTE_PER_BASE.toString()} QUOTE</span>
            . Bid <code className="rounded bg-zinc-100 px-1">price_limit</code> defaults to the same peg (
            <span className="font-mono">{ORDER_PRICE_LIMIT}</span>) so your quote deposit (
            <span className="font-mono">base × {QUOTE_PER_BASE.toString()}</span>) satisfies{" "}
            <span className="font-mono">amount × price_limit ≤ note_amount</span> on the ER. You place a{" "}
            <span className="font-semibold">bid</span> (quote collateral). Needs{" "}
            <code className="rounded bg-zinc-100 px-1">.devnet/e2e-config.json</code> and{" "}
            <code className="rounded bg-zinc-100 px-1">DEMO_MAKER_SECRET_BASE58</code>.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            refreshSession();
            setSession(readDappSession());
          }}
          className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-xs font-semibold text-zinc-700 hover:bg-zinc-50"
        >
          Refresh session
        </button>
      </div>

      {!s0 ? (
        <p className="text-sm text-zinc-600">Finish the identity step above — session will appear here.</p>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-end gap-3">
            <label className="text-xs text-zinc-600">
              Base size
              <input
                className="ml-2 w-24 rounded border border-zinc-300 px-2 py-1 font-mono text-sm"
                value={baseAmount}
                onChange={(e) => setBaseAmount(e.target.value)}
                disabled={step !== "idle" && step !== "registered"}
              />
            </label>
            <span className="text-xs font-mono text-zinc-500">
              quote leg: {(BigInt(baseAmount || "0") * QUOTE_PER_BASE).toString()} · nonce {depositNonce}
            </span>
          </div>

          {slotIdx != null ? (
            <p className="mb-2 text-xs text-zinc-600">
              ER slot: <span className="font-mono font-semibold">{slotIdx}</span>
            </p>
          ) : null}

          <button
            type="button"
            disabled={busy || step === "matched"}
            onClick={() => void nextAction()}
            className="rounded-md bg-emerald-800 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Working…" : label}
          </button>

          {error ? (
            <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">{error}</div>
          ) : null}

          {step === "matched" ? (
            <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
              <span className="font-semibold">Settlement complete.</span> On-chain withdraw still needs a Merkle
              proof source + browser <code className="mx-1 rounded bg-white px-1">VALID_SPEND</code> proof.
            </div>
          ) : null}

          {receipt.length > 0 ? (
            <div className="mt-5">
              <h3 className="text-sm font-semibold text-zinc-900">Transaction receipt</h3>
              <ul className="mt-2 space-y-1 text-xs">
                {receipt.map((r, i) => (
                  <li key={`${r.signature}-${i}`} className="font-mono text-zinc-700">
                    <span className="text-zinc-500">{r.label}</span>
                    {r.signature && r.signature !== "skipped" ? (
                      <>
                        {" "}·{" "}
                        <a
                          className="text-blue-600 hover:underline"
                          href={txUrl(r.signature)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {r.signature.slice(0, 10)}…
                        </a>{" "}
                        <span className="text-zinc-400">({r.cluster})</span>
                      </>
                    ) : (
                      <span className="ml-2 text-zinc-400">(no tx)</span>
                    )}
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
