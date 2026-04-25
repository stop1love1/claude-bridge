import { spawn, type ChildProcess } from "node:child_process";

/**
 * Cross-platform "kill the whole subtree" helper.
 *
 * Why this exists:
 *   - On Windows, `child.kill(...)` ultimately calls `TerminateProcess`
 *     on the parent PID only. Any sub-shell, git invocation, node
 *     subprocess, etc. that the spawned child started keeps running —
 *     the bridge's "Stop" button looks like it worked, but the work
 *     keeps happening invisibly. We shell out to `taskkill /F /T /PID`
 *     so the `/T` flag walks and terminates the descendant tree.
 *   - On POSIX, the bridge no longer spawns children with
 *     `detached: true`, so each child lives in the bridge's own process
 *     group. A plain `child.kill(signal)` is the right call —
 *     `process.kill(-pid)` would either ESRCH (no dedicated group
 *     exists) or, in the worst case, hit an unrelated group if PIDs
 *     happened to collide. The bridge process group itself gets
 *     SIGTERM'd by the operator's shell when they Ctrl-C, which
 *     propagates to all our children naturally.
 *
 * Strategy:
 *   - Windows: shell out to `taskkill /F /T /PID <pid>` (`/T` walks the
 *     descendant tree).
 *   - POSIX: `child.kill(signal)` — direct child only.
 *
 * Returns true on a best-effort attempt, false if there's nothing to
 * kill (no PID, exit already observed). Never throws — the caller
 * shouldn't have to wrap us in try/catch.
 */
export function treeKill(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): boolean {
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) {
    return false;
  }

  if (process.platform === "win32") {
    // taskkill is a noop if the process already exited; swallow stderr
    // either way. We don't `await` — kill is best-effort and the caller
    // re-checks via the registry anyway.
    try {
      const force = signal === "SIGKILL" ? ["/F"] : [];
      const tk = spawn(
        "taskkill",
        [...force, "/T", "/PID", String(pid)],
        { stdio: "ignore", windowsHide: true },
      );
      tk.on("error", () => { /* taskkill itself missing — ignore */ });
    } catch {
      // Last-ditch fallback: try child.kill — TerminateProcess on the
      // parent only, but better than zero.
      try { child.kill(signal); } catch { /* ignore */ }
    }
    return true;
  }

  // POSIX: children no longer spawned with detached:true → no dedicated
  // process group. Signal the direct child only. The bridge's own
  // process group catches Ctrl-C / shutdown signals and propagates to
  // our children naturally.
  try { child.kill(signal); return true; } catch { return false; }
}
