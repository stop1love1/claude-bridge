/**
 * Demo mode — when the bridge is deployed somewhere it can't actually
 * function (Vercel / Netlify / any serverless host without `claude`,
 * `git`, or persistent disk), `BRIDGE_DEMO_MODE` flips the entire
 * non-public surface off:
 *
 *   - Landing-page CTAs that point at `/apps` / `/tasks` are hidden,
 *     leaving only docs + GitHub anchors.
 *   - The proxy redirects `/apps`, `/tasks`, `/sessions`, `/settings`,
 *     `/login` to `/`.
 *   - All non-public `/api/*` routes return `503 { error: "demo mode" }`
 *     (the proxy handles this so individual routes don't have to).
 *
 * The flag is read once at module load. Vercel injects env vars at the
 * start of each server invocation, so this is correct per-request even
 * though we read it eagerly. Locally it picks up `.env.local` /
 * `BRIDGE_DEMO_MODE=1 bun dev` without restart-after-edit fuss.
 *
 * Accepted truthy values: `1`, `true`, `yes` (case-insensitive,
 * trimmed). Anything else — including missing — is `false`.
 */
export const DEMO_MODE: boolean = (() => {
  const raw = (process.env.BRIDGE_DEMO_MODE ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
})();
