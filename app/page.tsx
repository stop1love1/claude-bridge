import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  COOKIE_NAME,
  findTrustedDevice,
  loadAuthConfig,
  verifySession,
} from "@/lib/auth";
import { DEMO_MODE } from "@/lib/demoMode";
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
} from "./_landing/sections";
import { REPO_URL } from "./_landing/constants";

const SITE_NAME = "Claude Bridge";
const SITE_TAGLINE =
  "Hand off the task — go grab a coffee. The bridge dispatches Claude across every repo, verifies the work, and pings you when it ships.";

export const metadata: Metadata = {
  title: {
    default: "Claude Bridge — Multi-repo dispatch for Claude Code",
    template: "%s · Claude Bridge",
  },
  description: SITE_TAGLINE,
  applicationName: SITE_NAME,
  keywords: [
    "Claude Code",
    "Anthropic",
    "AI agents",
    "multi-repo orchestration",
    "agent dashboard",
    "dev tools",
    "Next.js",
    "Bun",
    "automation",
  ],
  authors: [{ name: "stop1love1", url: "https://github.com/stop1love1" }],
  creator: "stop1love1",
  publisher: "stop1love1",
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    title: "Claude Bridge — Multi-repo dispatch for Claude Code",
    description: SITE_TAGLINE,
    images: [
      {
        url: "/logo.svg",
        width: 512,
        height: 512,
        alt: "Claude Bridge logo",
      },
    ],
  },
  twitter: {
    card: "summary",
    title: "Claude Bridge — Multi-repo dispatch for Claude Code",
    description: SITE_TAGLINE,
    images: ["/logo.svg"],
  },
  icons: { icon: "/logo.svg", shortcut: "/logo.svg", apple: "/logo.svg" },
  category: "developer-tools",
};

const STRUCTURED_DATA = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: SITE_NAME,
  applicationCategory: "DeveloperApplication",
  operatingSystem: "macOS, Linux, Windows",
  description: SITE_TAGLINE,
  url: REPO_URL,
  codeRepository: REPO_URL,
  programmingLanguage: ["TypeScript", "JavaScript"],
  author: { "@type": "Person", name: "stop1love1", url: "https://github.com/stop1love1" },
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
};

export default async function HomePage() {
  // Already-authed operators see `/apps` as their real home — the
  // landing page is for first-time visitors / logged-out sessions only.
  // Mirrors the proxy.ts cookie + trusted-device check so a revoked
  // device isn't treated as logged in here.
  //
  // Demo deployments skip the auth-redirect entirely: `/apps` doesn't
  // function there, so we always render the landing page regardless of
  // any stale cookie a visitor might be carrying.
  if (!DEMO_MODE) {
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
        <FAQ />
        <FinalCTA />
      </main>
      <LandingFooter />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(STRUCTURED_DATA) }}
      />
    </div>
  );
}
