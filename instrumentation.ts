/**
 * Next.js instrumentation hook — runs once per server boot (and on HMR
 * reload in dev). We use it to:
 *
 *   1. Install the Telegram notifier so the subscription is in place
 *      before any task runs land.
 *   2. Print a one-shot health banner (`[bridge] …`) covering Claude
 *      CLI, auth state, registered apps, and both Telegram channels —
 *      so the operator immediately sees what's wired up vs missing
 *      instead of finding out later when something silently no-ops.
 *   3. Register the tunnel-shutdown signal handler eagerly. Doing it
 *      here (rather than lazily inside `startTunnel`) means a SIGINT
 *      delivered before any tunnel exists still leaves a usable
 *      handler in place; HMR-trapped stale closures are also gone
 *      because we install before the route module is reloaded.
 *
 * Everything below is a no-op on the Edge runtime; only `nodejs` boots
 * exercise startup checks, the notifier, and the tunnel handler.
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Health banner first — runs in parallel with the notifier install
  // (we don't `await` it). Notifier install is synchronous-ish, so
  // doing it second keeps any "telegram notifier installed" log next
  // to the matching banner line. Both swallow their own errors.
  const { runStartupChecks } = await import("./libs/startupChecks");
  void runStartupChecks().catch((err: unknown) => {
    console.warn("[bridge] startup checks failed:", (err as Error).message);
  });

  const { ensureTelegramNotifier } = await import("./libs/telegramNotifier");
  ensureTelegramNotifier();

  // Auto-nudge an idle coordinator when its children settle. Without
  // this the coordinator has to poll meta.json on its own (or wait for
  // its self-scheduled wakeup) — which is why "child finished, but
  // coordinator never picks up unless I ping" was the recurring UX
  // complaint pre-fix. Idempotent + HMR-safe (state lives on globalThis).
  const { ensureCoordinatorNudge } = await import("./libs/coordinatorNudge");
  ensureCoordinatorNudge();

  // Tunnel shutdown handlers live behind a dynamic import so the Node-
  // only `process.once` / `process.exit` calls stay invisible to the
  // Edge runtime static analyzer.
  const { installShutdownHandlers } = await import("./libs/shutdownHandler");
  installShutdownHandlers();
}
