import type { Metadata, Viewport } from "next";
import Script from "next/script";
import "./globals.css";
import { Providers } from "./_components/Providers";
import { NO_FLASH_SCRIPT } from "@/libs/themeBootstrap";

// Resolves relative `openGraph.images` / `twitter.images` URLs. The bridge is
// a localhost dashboard, so we fall back to the dev port; deploys can override
// via `NEXT_PUBLIC_SITE_URL`.
const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? `http://localhost:${process.env.PORT ?? 7777}`;

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Claude Bridge",
    template: "%s | Claude Bridge",
  },
  description: "Owner dashboard for dispatching cross-repo tasks to a Claude agent team.",
};

// Explicit viewport so iOS Safari behaves: `initial-scale=1` keeps
// the page at 100% on first paint, and we leave pinch-to-zoom enabled
// (no `maximum-scale=1`) for accessibility.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <body className="min-h-full flex flex-col bg-background text-foreground">
        {/* First in body + `beforeInteractive` — runs before hydration, avoids
            raw <script> in React tree warnings; theme matches storage before paint. */}
        <Script
          id="bridge-theme-no-flash"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{ __html: NO_FLASH_SCRIPT }}
        />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
