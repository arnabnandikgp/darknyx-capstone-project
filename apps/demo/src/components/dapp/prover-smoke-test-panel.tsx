"use client";

import { useState } from "react";

import { useDappContext } from "@/lib/dapp/dapp-context";

interface ProverFixture {
  ok: true;
  inputs: {
    userCommitment: string;
    rootKey: [string, string];
    spendingKey: string;
    viewingKey: string;
    r0: string;
    r1: string;
    r2: string;
  };
  expected: {
    userCommitmentHex: string;
    userCommitmentDecimal: string;
  };
}

type StepStatus = "idle" | "running" | "success" | "error";

interface StepState {
  label: string;
  status: StepStatus;
  detail?: string;
  durationMs?: number;
}

const INITIAL_STEPS: StepState[] = [
  { label: "Fetch deterministic fixture from server", status: "idle" },
  { label: "Boot WebProverSuite (worker + snarkjs)", status: "idle" },
  { label: "Generate VALID_WALLET_CREATE Groth16 proof", status: "idle" },
  { label: "Verify public input matches server commitment", status: "idle" },
];

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function ProverSmokeTestPanel() {
  const { getProver } = useDappContext();
  const [steps, setSteps] = useState<StepState[]>(INITIAL_STEPS);
  const [running, setRunning] = useState(false);

  const updateStep = (idx: number, patch: Partial<StepState>) => {
    setSteps((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  };

  const reset = () => {
    setSteps(INITIAL_STEPS);
  };

  const runSmokeTest = async () => {
    if (running) return;
    setRunning(true);
    reset();

    try {
      // Step 1: fetch fixture
      updateStep(0, { status: "running" });
      const t1 = performance.now();
      const res = await fetch("/api/dapp/prover-fixture", { cache: "no-store" });
      if (!res.ok) {
        throw new Error(`fixture fetch failed: HTTP ${res.status}`);
      }
      const fixture = (await res.json()) as ProverFixture;
      updateStep(0, {
        status: "success",
        durationMs: Math.round(performance.now() - t1),
        detail: `userCommitment = 0x${fixture.expected.userCommitmentHex.slice(0, 12)}…`,
      });

      // Step 2: boot prover (shared singleton from <DappContextProvider>)
      updateStep(1, { status: "running" });
      const t2 = performance.now();
      const prover = getProver();
      prover.prefetch();
      updateStep(1, {
        status: "success",
        durationMs: Math.round(performance.now() - t2),
        detail: "worker spawned, snarkjs lazy-loaded inside worker",
      });

      // Step 3: prove
      updateStep(2, { status: "running" });
      const t3 = performance.now();
      const proof = await prover.walletCreate.prove({
        userCommitment: BigInt(fixture.inputs.userCommitment),
        rootKey: [BigInt(fixture.inputs.rootKey[0]), BigInt(fixture.inputs.rootKey[1])],
        spendingKey: BigInt(fixture.inputs.spendingKey),
        viewingKey: BigInt(fixture.inputs.viewingKey),
        r0: BigInt(fixture.inputs.r0),
        r1: BigInt(fixture.inputs.r1),
        r2: BigInt(fixture.inputs.r2),
      });
      updateStep(2, {
        status: "success",
        durationMs: Math.round(performance.now() - t3),
        detail: `pi_a ${proof.piA.length}B · pi_b ${proof.piB.length}B · pi_c ${proof.piC.length}B · publicInputs ${proof.publicInputs.length}`,
      });

      // Step 4: verify public input
      updateStep(3, { status: "running" });
      const expectedHex = fixture.expected.userCommitmentHex;
      const actualHex = bytesToHex(proof.publicInputs[0]);
      if (actualHex !== expectedHex) {
        throw new Error(
          `public input mismatch — expected 0x${expectedHex} got 0x${actualHex}`,
        );
      }
      updateStep(3, {
        status: "success",
        detail: `0x${actualHex.slice(0, 12)}…${actualHex.slice(-8)} ✓ matches server`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setSteps((prev) => {
        const next = [...prev];
        const runningIdx = next.findIndex((s) => s.status === "running");
        if (runningIdx >= 0) {
          next[runningIdx] = { ...next[runningIdx], status: "error", detail: message };
        }
        return next;
      });
    } finally {
      setRunning(false);
    }
  };

  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-zinc-900">
            Browser ZK prover · smoke test
          </h2>
          <p className="mt-1 max-w-xl text-xs text-zinc-600">
            Verifies that <code className="rounded bg-zinc-100 px-1">snarkjs</code> can
            generate a <code className="rounded bg-zinc-100 px-1">VALID_WALLET_CREATE</code>{" "}
            proof inside a Web Worker using the wasm + zkey served from{" "}
            <code className="rounded bg-zinc-100 px-1">/circuits</code>. Run this once
            after a fresh build to confirm the prover pipeline is healthy.
          </p>
        </div>
        <button
          type="button"
          onClick={runSmokeTest}
          disabled={running}
          className="rounded-md bg-zinc-900 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-white transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {running ? "Running…" : "Run smoke test"}
        </button>
      </div>
      <ol className="space-y-2">
        {steps.map((step) => (
          <li
            key={step.label}
            className="flex items-start gap-3 rounded-md border border-zinc-100 bg-zinc-50 px-3 py-2 text-xs"
          >
            <StatusBadge status={step.status} />
            <div className="flex-1">
              <div className="flex items-center gap-2 text-zinc-800">
                <span className="font-semibold">{step.label}</span>
                {step.durationMs != null ? (
                  <span className="font-mono text-[10px] text-zinc-500">
                    {step.durationMs}ms
                  </span>
                ) : null}
              </div>
              {step.detail ? (
                <div className="mt-0.5 break-all font-mono text-[11px] text-zinc-600">
                  {step.detail}
                </div>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function StatusBadge({ status }: { status: StepStatus }) {
  const cls: Record<StepStatus, string> = {
    idle: "bg-zinc-300 text-zinc-700",
    running: "bg-amber-200 text-amber-900",
    success: "bg-emerald-200 text-emerald-900",
    error: "bg-red-200 text-red-900",
  };
  const label: Record<StepStatus, string> = {
    idle: "—",
    running: "···",
    success: "✓",
    error: "✕",
  };
  return (
    <span
      className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${cls[status]}`}
      aria-label={status}
    >
      {label[status]}
    </span>
  );
}
