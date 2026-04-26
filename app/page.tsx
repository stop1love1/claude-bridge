import {
  Features,
  FinalCTA,
  HighlightStrip,
  Hero,
  HowItWorks,
  LandingFooter,
  LandingHeader,
  Preview,
  QuickLinks,
  Stats,
} from "./_landing/sections";

export default function HomePage() {
  return (
    <div className="flex flex-col min-h-screen">
      <LandingHeader />
      <main className="flex-1">
        <Hero />
        <HighlightStrip />
        <Features />
        <Stats />
        <HowItWorks />
        <Preview />
        <QuickLinks />
        <FinalCTA />
      </main>
      <LandingFooter />
    </div>
  );
}
