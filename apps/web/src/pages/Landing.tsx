import {
  CallToAction, Capabilities, Hero, HowItWorks, MarketingFooter, MarketingNav,
} from "~/components/landing/Sections.tsx";
import { useReveal } from "~/lib/useReveal.ts";

/** Public marketing page — explains the product before auth. */
export function Landing() {
  useReveal();

  return (
    <div className="landing min-h-screen">
      <MarketingNav />
      <main>
        <Hero />
        <HowItWorks />
        <Capabilities />
        <CallToAction />
      </main>
      <MarketingFooter />
    </div>
  );
}
