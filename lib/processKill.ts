import { spawn, type ChildProcess } from "node:child_process";

/**
 * Cross-platform "kill the whole subtree" helper.
 *
 * Why this exists:
 *   - On Windows, `child.kill(...)` ultimately calls `TerminateProcess`
 *     on the parent PID only. Any sub-shell, git invocation, node
 *     subprocess, etc. that the spawned child started keeps running —
 *     the bridge's "Stop" button looks like it worked, but the work
 *     keeps happening invisibly.
 *   - On POSIX, when a child was spawned with `detached: true` it lives
 *     in its own process group. Sending a signal to the parent PID does
 *     NOT propagate to the rest of the group; we have to negate the PID
 *     (`process.kill(-pid, signal)`) to hit the whole group.
 *
 * Strategy:
 *   - Windows: shell out to `taskkill /F /T /PID <pid>` (`/T` walks the
 *     descendant tree).
 *   - POSIX (detached): `process.kill(-pid, signal)` to hit the group.
 *   - POSIX (not detached): plain `child.kill(signal)`.
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

  // POSIX. If the child was spawned with `detached: true`, its PID also
  // identifies its process group, so `kill(-pid)` signals the group.
  // Node doesn't expose the `detached` flag back to us, so we try the
  // group form first and fall back to the plain form.
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      child.kill(signal);
      return true;
    } catch {
      return false;
    }
  }
}
