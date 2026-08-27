import type { ChildProcess } from "node:child_process";
import { treeKill } from "./processKill";


interface Registry {
  children: Map<string, ChildProcess>;
}

const G = globalThis as unknown as { __bridgeSpawnRegistry?: Registry };
const registry: Registry = G.__bridgeSpawnRegistry ?? { children: new Map() };
G.__bridgeSpawnRegistry = registry;

export function registerChild(sessionId: string, child: ChildProcess): void {
  registry.children.set(sessionId, child);
  child.on("exit", () => {
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

export function killChild(sessionId: string): boolean {
  const child = registry.children.get(sessionId);
  if (!child) return false;
  treeKill(child, "SIGTERM");
  const t = setTimeout(() => {
    if (registry.children.get(sessionId) === child) {
      treeKill(child, "SIGKILL");
    }
  }, 3000);
  if (typeof t.unref === "function") t.unref();
  return true;
}
