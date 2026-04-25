import type { ChildProcess } from "node:child_process";
import { treeKill } from "./processKill";

/**
 * In-process registry of live child Claude processes, keyed by session
 * UUID. Used by the kill endpoint and (eventually) Phase C tree views to
 * answer "is this run actually still alive?" without touching the
 * filesystem. NOT persisted — a server restart drops every entry, and
 * the stale-run reaper picks up the orphaned `running` rows in meta.json.
 *
 * Stashed on `globalThis` so Next.js dev HMR doesn't lose track of
 * in-flight children when a route module reloads. The same trick is
 * used by `permissionStore.ts`.
 */

interface Registry {
  children: Map<string, ChildProcess>;
}

const G = globalThis as unknown as { __bridgeSpawnRegistry?: Registry };
const registry: Registry = G.__bridgeSpawnRegistry ?? { children: new Map() };
G.__bridgeSpawnRegistry = registry;

/**
 * Track a child process under its session UUID. Auto-unregisters on
 * `exit` so callers don't have to remember the cleanup wiring. Safe to
 * call more than once — the latest registration wins (we replace the
 * previous handle, which would only happen if a session id was reused,
 * which shouldn't ever occur in practice).
 */
export function registerChild(sessionId: string, child: ChildProcess): void {
  registry.children.set(sessionId, child);
  child.on("exit", () => {
    // Only clear if the entry is still THIS child — if something else
    // re-registered the same id (shouldn't happen, but defensive), we
    // don't want to clobber the new handle.
    if (registry.children.get(sessionId) === child) {
      registry.children.delete(sessionId);
    }
  });
}

export function getChild(sessionId: string): ChildProcess | undefined {
  return registry.children.get(sessionId);
}

export function unregisterChild(sessionId: string): void {
  registry.children.delete(sessionId);
}

/**
 * Send SIGTERM, then SIGKILL after a 3s grace period if the process is
 * still alive. Returns true if a child was found (and a kill was sent),
 * false if the session id has no live process registered. Idempotent
 * for the false case.
 *
 * Uses `treeKill` so on Windows we kill the whole descendant tree
 * (taskkill /T) instead of just the parent PID. On POSIX we send the
 * signal to the direct child — children no longer spawn with
 * `detached: true`, so they're already in the bridge's own process
 * group and sub-shells get cleaned up via the normal exit cascade.
 */
export function killChild(sessionId: string): boolean {
  const child = registry.children.get(sessionId);
  if (!child) return false;
  treeKill(child, "SIGTERM");
  // Escalate to SIGKILL after 3s if SIGTERM didn't take. We unref the
  // timer so node won't keep the event loop alive just for this.
  const t = setTimeout(() => {
    if (registry.children.get(sessionId) === child) {
      treeKill(child, "SIGKILL");
    }
  }, 3000);
  if (typeof t.unref === "function") t.unref();
  return true;
}
