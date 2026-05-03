import {
  FAQ,
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
} from "@/components/landing/sections";

/**
 * Public marketing landing page mounted at `/`.
 *
 * Ported from `app/page.tsx` on `main`. The Next.js version
 * server-side-redirected authed operators to `/apps`; the SPA can't do
 * that without round-tripping the cookie, so we always render the full
 * landing page and rely on the "Open dashboard" CTAs to send the user
 * onward. `/dashboard` redirects to `/tasks` for users with bookmarks
 * or muscle memory from the legacy site.
 */
export default function Landing() {
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
        <FAQ />
        <FinalCTA />
      </main>
      <LandingFooter />
    </div>
  );
}
