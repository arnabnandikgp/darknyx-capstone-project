"use client";

import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { clusterApiUrl } from "@solana/web3.js";
import { useMemo } from "react";

import "@solana/wallet-adapter-react-ui/styles.css";

/**
 * DappProviders — Solana wallet-adapter context for the live `/dapp` flow.
 *
 * - `ConnectionProvider` exposes a `Connection` to all hooks (we read RPC URL
 *   from `NEXT_PUBLIC_DEVNET_RPC_URL`, falling back to the public devnet
 *   endpoint).
 * - `WalletProvider` enables auto-discovery of any wallet that implements the
 *   Wallet Standard (Phantom, Solflare, Backpack, etc.) so we don't need a
 *   per-wallet adapter list.
 * - `WalletModalProvider` powers the `<WalletMultiButton />` UI from the
 *   `react-ui` package.
 */
export function DappProviders({ children }: { children: React.ReactNode }) {
  const endpoint = useMemo(() => {
    const fromEnv = process.env.NEXT_PUBLIC_DEVNET_RPC_URL;
    return fromEnv && fromEnv.length > 0 ? fromEnv : clusterApiUrl("devnet");
  }, []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={[]} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
