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
 *
 * Both are no-ops on the Edge runtime; everything below only runs when
 * NEXT_RUNTIME === "nodejs".
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Health banner first — runs in parallel with the notifier install
  // (we don't `await` it). Notifier install is synchronous-ish, so
  // doing it second keeps any "telegram notifier installed" log next
  // to the matching banner line. Both swallow their own errors.
  const { runStartupChecks } = await import("./lib/startupChecks");
  void runStartupChecks().catch((err: unknown) => {
    console.warn("[bridge] startup checks failed:", (err as Error).message);
  });

  const { ensureTelegramNotifier } = await import("./lib/telegramNotifier");
  ensureTelegramNotifier();
}
