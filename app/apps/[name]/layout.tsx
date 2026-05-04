import type { Metadata } from "next";

export const metadata: Metadata = {
  /** Replaced client-side in `<AppDetail>` once the registry name resolves. */
  title: "Apps",
};

export default function AppDetailLayout({ children }: { children: React.ReactNode }) {
  return children;
}
