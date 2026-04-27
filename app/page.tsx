import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  COOKIE_NAME,
  findTrustedDevice,
  loadAuthConfig,
  verifySession,
} from "@/lib/auth";
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

export default async function HomePage() {
  // Already-authed operators see `/apps` as their real home — the
  // landing page is for first-time visitors / logged-out sessions only.
  // Mirrors the proxy.ts cookie + trusted-device check so a revoked
  // device isn't treated as logged in here.
  const cfg = loadAuthConfig();
  if (cfg) {
    const token = (await cookies()).get(COOKIE_NAME)?.value;
    if (token) {
      const payload = verifySession(token, cfg.secret);
      if (payload && (!payload.did || findTrustedDevice(payload.did))) {
        redirect("/apps");
      }
    }
  }

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
