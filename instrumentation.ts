/**
 * Next.js instrumentation hook — runs once per server boot (and on HMR
 * reload in dev). We use it to install the Telegram notifier so the
 * subscription is in place before any task runs land.
 *
 * The notifier is a no-op unless TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID
 * are present in the env, so this import is safe to leave on by
 * default — there's no network call until both are configured.
 */
export async function register(): Promise<void> {
  // Edge runtime doesn't have a network notifier; only wire on Node.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { ensureTelegramNotifier } = await import("./lib/telegramNotifier");
  ensureTelegramNotifier();
}
