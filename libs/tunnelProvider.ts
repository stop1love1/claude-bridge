/**
 * The tunnel provider vocabulary, kept in a dependency-free module so both the
 * runtime (`tunnels.ts`) and the settings layer (`bridgeSettings.ts`) can agree
 * on it without an import cycle. Adding a provider means editing this list and
 * nothing else — four separate hand-maintained copies of it once existed, and
 * the one in the settings reader silently dropped any provider it had not been
 * taught about.
 */
export type TunnelProvider = "localtunnel" | "ngrok" | "cloudflared";

export const TUNNEL_PROVIDERS: readonly TunnelProvider[] = [
  "localtunnel",
  "ngrok",
  "cloudflared",
] as const;

export function isTunnelProvider(v: unknown): v is TunnelProvider {
  return typeof v === "string" && (TUNNEL_PROVIDERS as readonly string[]).includes(v);
}
