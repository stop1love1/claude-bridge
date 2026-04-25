import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./_components/Providers";

export const metadata: Metadata = {
  title: "Claude Bridge",
  description: "Owner dashboard for dispatching cross-repo tasks to a Claude agent team.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
