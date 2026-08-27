
import { killAllTunnels } from "./tunnels";
import { releaseProcessLock } from "./processLock";

interface ShutdownGlobal { __bridgeShutdownInstalled?: boolean }

export function installShutdownHandlers(): void {
  const g = globalThis as unknown as ShutdownGlobal;
  if (g.__bridgeShutdownInstalled) return;
  g.__bridgeShutdownInstalled = true;

  const onSignal = (code: number) => {
    try { killAllTunnels(); } catch { }
    try { releaseProcessLock(); } catch { }
    process.exit(code);
  };
  process.once("SIGINT", () => onSignal(130));
  process.once("SIGTERM", () => onSignal(143));
  process.once("exit", () => {
    try { killAllTunnels(); } catch { }
    try { releaseProcessLock(); } catch { }
  });
}
