/**
 * Process-level shutdown wiring for the bridge: kills any active
 * tunnel children on SIGINT / SIGTERM / `exit` so we don't orphan
 * `lt` / `ngrok` subprocesses.
 *
 * Lives in its own module (rather than inline in `instrumentation.ts`)
 * so the Node.js-only `process.once` / `process.exit` calls stay
 * behind a dynamic-import boundary. The Edge runtime static analyzer
 * scans `instrumentation.ts` for both runtimes, and a runtime guard
 * (`if NEXT_RUNTIME === "nodejs"`) is not enough on its own.
 */

import { killAllTunnels } from "./tunnels";

interface ShutdownGlobal { __bridgeShutdownInstalled?: boolean }

export function installShutdownHandlers(): void {
  const g = globalThis as unknown as ShutdownGlobal;
  if (g.__bridgeShutdownInstalled) return;
  g.__bridgeShutdownInstalled = true;

  const onSignal = (code: number) => {
    try { killAllTunnels(); } catch { /* best-effort on shutdown */ }
    // The OS reaps children once we exit; still call exit explicitly so
    // a stuck Telegram poller can't keep the process alive past the
    // signal. Numeric code matches POSIX convention (SIGINT → 130,
    // SIGTERM → 143).
    process.exit(code);
  };
  process.once("SIGINT", () => onSignal(130));
  process.once("SIGTERM", () => onSignal(143));
  process.once("exit", () => {
    try { killAllTunnels(); } catch { /* best-effort */ }
  });
}
