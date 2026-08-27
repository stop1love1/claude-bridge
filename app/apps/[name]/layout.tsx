import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Apps",
};

export default function AppDetailLayout({ children }: { children: React.ReactNode }) {
  return children;
}
