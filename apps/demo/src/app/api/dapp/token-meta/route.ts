import { NextResponse } from "next/server";

import { loadDemoE2eConfig, resolveRepoRoot } from "@/lib/dapp/demo-devnet";

export const runtime = "nodejs";

/**
 * Public read-only mint + peg metadata for the demo dapp. Lets the browser
 * derive human-token labels without baking mint decimals into NEXT_PUBLIC_*
 * env vars (which drift from `.devnet/e2e-config.json` after a re-bootstrap).
 */
export async function GET() {
  try {
    const repoRoot = resolveRepoRoot();
    const cfg = loadDemoE2eConfig(repoRoot);
    const exchangeQuotePerBaseAtomic =
      process.env.NEXT_PUBLIC_DEMO_EXCHANGE_QUOTE_PER_BASE ??
      process.env.DEMO_EXCHANGE_QUOTE_PER_BASE ??
      "100";
    const orderPriceLimit =
      process.env.NEXT_PUBLIC_DEMO_ORDER_PRICE ??
      process.env.DEMO_ORDER_PRICE ??
      exchangeQuotePerBaseAtomic;

    return NextResponse.json({
      ok: true,
      baseDecimals: cfg.baseMint.decimals,
      quoteDecimals: cfg.quoteMint.decimals,
      exchangeQuotePerBaseAtomic,
      orderPriceLimit,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
