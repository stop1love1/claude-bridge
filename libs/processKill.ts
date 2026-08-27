import { spawn, type ChildProcess } from "node:child_process";

export function treeKill(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): boolean {
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) {
    return false;
  }

  if (process.platform === "win32") {
    try {
      const tk = spawn(
        "taskkill",
        ["/F", "/T", "/PID", String(pid)],
        { stdio: "ignore", windowsHide: true },
      );
      tk.on("error", () => { });
    } catch {
      try { child.kill(signal); } catch { }
    }
    return true;
  }

  try { child.kill(signal); return true; } catch { return false; }
}
