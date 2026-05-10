import { NyxFooter } from "@/components/brand/nyx-footer";
import { NyxNav } from "@/components/brand/nyx-nav";
import { CtaSection } from "@/components/landing/cta-section";
import { FeatureGrid } from "@/components/landing/feature-grid";
import { FlowDiagram } from "@/components/landing/flow-diagram";
import { LandingHero } from "@/components/landing/hero";
import { StackStrip } from "@/components/landing/stack-strip";

export default function Home() {
  return (
    <div className="flex min-h-screen flex-1 flex-col bg-nyx-ink text-nyx-chalk">
      <NyxNav tone="ink" active="home" launchHref="/dapp" />
      <main className="flex-1">
        <LandingHero />
        <FeatureGrid />
        <FlowDiagram />
        <StackStrip />
        <CtaSection />
      </main>
      <NyxFooter tone="ink" />
    </div>
  );
}
