import type { Metadata, Viewport } from "next";
import Script from "next/script";
import "./globals.css";
import { Providers } from "./_components/Providers";
import { NO_FLASH_SCRIPT } from "@/libs/themeBootstrap";

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? `http://localhost:${process.env.PORT ?? 7777}`;

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Claude Bridge",
    template: "%s | Claude Bridge",
  },
  description: "Owner dashboard for dispatching cross-repo tasks to a Claude agent team.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Claude Bridge",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#12151c",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <body className="min-h-full flex flex-col bg-background text-foreground">
        {}
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
