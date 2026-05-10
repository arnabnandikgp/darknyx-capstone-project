import type { Metadata } from "next";

import { ArchitectureHero } from "@/components/architecture/architecture-hero";
import { CryptoPrimitives } from "@/components/architecture/crypto-primitives";
import { PrivacyTable } from "@/components/architecture/privacy-table";
import { SecurityAndRoadmap } from "@/components/architecture/security-and-roadmap";
import { SystemOverview } from "@/components/architecture/system-overview";
import { TransactionFlow } from "@/components/architecture/transaction-flow";
import { NyxFooter } from "@/components/brand/nyx-footer";
import { NyxNav } from "@/components/brand/nyx-nav";
import { CtaSection } from "@/components/landing/cta-section";

export const metadata: Metadata = {
  title: "Nyx · architecture",
  description:
    "How the Nyx darkpool keeps order intent private without giving up on-chain auditability — three layers, two clusters, one verifiable settlement.",
};

export default function ArchitecturePage() {
  return (
    <div className="flex min-h-screen flex-1 flex-col bg-nyx-ink text-nyx-chalk">
      <NyxNav tone="ink" active="architecture" launchHref="/dapp" />
      <main className="flex-1">
        <ArchitectureHero />
        <SystemOverview />
        <PrivacyTable />
        <TransactionFlow />
        <CryptoPrimitives />
        <SecurityAndRoadmap />
        <CtaSection />
      </main>
      <NyxFooter tone="ink" />
    </div>
  );
}
