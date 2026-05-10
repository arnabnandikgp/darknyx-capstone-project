"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import type { Connection } from "@solana/web3.js";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";

import { PhantomTransactionForwarder } from "@/lib/dapp/phantom-forwarder";
import { WebProverSuite } from "@/lib/web-prover/web-prover-suite";

export interface DappContextValue {
  /** Solana RPC connection from `<ConnectionProvider>`. */
  connection: Connection;
  /** Wallet state from `useWallet()`. */
  wallet: WalletContextState;
  /**
   * Lazily-allocated singleton (per page lifetime).
   * Only call once you actually need to prove — calling on the server side
   * (during SSR) throws.
   */
  getProver(): WebProverSuite;
  /** Forwarder bound to the current connection + wallet. */
  forwarder: PhantomTransactionForwarder;
}

const DappContext = createContext<DappContextValue | null>(null);

/**
 * DappContextProvider — wires the connected wallet, RPC connection, browser
 * ZK prover, and Phantom forwarder into one context.
 *
 * The prover is held in a ref and instantiated lazily on first call to
 * `getProver()` (so SSR never tries to construct it). The provider value is
 * stable across renders of the inner tree as long as the connection / wallet
 * identity doesn't change.
 */
export function DappContextProvider({ children }: { children: ReactNode }) {
  const { connection } = useConnection();
  const wallet = useWallet();

  const proverRef = useRef<WebProverSuite | null>(null);

  // Tear down the worker on full unmount (e.g. user navigates away from /dapp)
  useEffect(() => {
    return () => {
      proverRef.current?.dispose();
      proverRef.current = null;
    };
  }, []);

  const value = useMemo<DappContextValue>(() => {
    const forwarder = new PhantomTransactionForwarder({
      connection,
      wallet,
      commitment: "confirmed",
    });
    return {
      connection,
      wallet,
      forwarder,
      getProver: () => {
        if (typeof window === "undefined") {
          throw new Error(
            "DappContext.getProver() called during SSR — gate behind a 'use client' boundary",
          );
        }
        if (proverRef.current == null) {
          proverRef.current = new WebProverSuite();
        }
        return proverRef.current;
      },
    };
  }, [connection, wallet]);

  return <DappContext.Provider value={value}>{children}</DappContext.Provider>;
}

/** Primary entry point. Throws if used outside `<DappContextProvider>`. */
export function useDappContext(): DappContextValue {
  const ctx = useContext(DappContext);
  if (ctx == null) {
    throw new Error(
      "useDappContext must be used inside <DappContextProvider> (mounted by /dapp/layout.tsx)",
    );
  }
  return ctx;
}
