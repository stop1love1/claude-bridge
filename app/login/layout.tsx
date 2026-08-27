import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { DEMO_MODE } from "@/libs/demoMode";

export const metadata: Metadata = {
  title: "Login",
};

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  if (DEMO_MODE) redirect("/");
  return children;
}
