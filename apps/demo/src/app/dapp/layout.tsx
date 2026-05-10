import type { ReactNode } from "react";

import { DappContextProvider } from "@/lib/dapp/dapp-context";
import { DappProviders } from "@/components/dapp/wallet-providers";

export const metadata = {
  title: "Nyx Dapp — Live Phantom Flow",
  description:
    "Connect a Phantom wallet, derive darkpool keys, deposit, and trade against a private counterparty on Solana devnet.",
};

export default function DappLayout({ children }: { children: ReactNode }) {
  return (
    <DappProviders>
      <DappContextProvider>{children}</DappContextProvider>
    </DappProviders>
  );
}
