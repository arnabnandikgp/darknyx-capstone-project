export type TimelineLayer = "L1" | "ER";

export type TimelinePrivacy = "visible" | "private" | "mixed";

export interface PrivacyTimelineStep {
  id: string;
  title: string;
  layer: TimelineLayer;
  privacy: TimelinePrivacy;
  summary: string;
  evidenceLabel?: string;
  signature?: string;
}

export const DEMO_TIMELINE_STEPS: PrivacyTimelineStep[] = [
  {
    id: "deposit",
    title: "Deposit collateral",
    layer: "L1",
    privacy: "visible",
    summary:
      "Vault deposit is on L1. Token mint, source, destination, and amount are public.",
  },
  {
    id: "delegate-slots",
    title: "Init + delegate pending order slots",
    layer: "L1",
    privacy: "visible",
    summary:
      "Slot allocation/delegation setup is visible on L1, but no order intent exists yet.",
  },
  {
    id: "submit-order-a",
    title: "Alice submit_order",
    layer: "ER",
    privacy: "private",
    summary:
      "Order intent stays in ER: side, amount, price, and note linkage are not emitted on L1.",
  },
  {
    id: "submit-order-b",
    title: "Bob submit_order",
    layer: "ER",
    privacy: "private",
    summary:
      "Counterparty order intent also stays in ER. L1 observes no order-book event.",
  },
  {
    id: "run-batch",
    title: "Run batch match in TEE",
    layer: "ER",
    privacy: "private",
    summary:
      "Matching happens inside the enclave. Internal crossing logic does not leak as L1 logs.",
  },
  {
    id: "commit-state",
    title: "Commit market state back to L1",
    layer: "L1",
    privacy: "mixed",
    summary:
      "L1 receives committed state and settlement artifacts, but not raw pre-trade order intent.",
  },
  {
    id: "settle",
    title: "Lock + settle matched notes",
    layer: "L1",
    privacy: "mixed",
    summary:
      "Settlement instructions are public, while spending/view keys and plaintext note secrets remain hidden.",
  },
  {
    id: "withdraw-check",
    title: "Withdraw + nullifier replay check",
    layer: "L1",
    privacy: "visible",
    summary:
      "First withdrawal succeeds. Replay is rejected on-chain with NullifierAlreadySpent.",
  },
];
