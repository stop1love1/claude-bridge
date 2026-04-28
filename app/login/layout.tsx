import { redirect } from "next/navigation";
import { DEMO_MODE } from "@/lib/demoMode";

/**
 * Demo deployments don't run a real auth backend (no persistent disk
 * for `~/.claude/bridge.json`, no operator on the other end), so the
 * login surface has nothing to do. Redirect every visit to `/`.
 *
 * `/login` is excluded from the proxy matcher (so the proxy doesn't
 * loop redirecting unauth'd users to `/login` and back), which means
 * the demo gate has to live here at the route level instead.
 */
export default function LoginLayout({ children }: { children: React.ReactNode }) {
  if (DEMO_MODE) redirect("/");
  return children;
}
