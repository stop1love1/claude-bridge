import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BRIDGE_LOGIC_DIR } from "./paths";

const HOUSE_RULES_CAP_BYTES = 32 * 1024;

function safeReadCapped(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const buf = readFileSync(path);
    return buf.subarray(0, HOUSE_RULES_CAP_BYTES).toString("utf8").trim() || null;
  } catch {
    return null;
  }
}

export function loadGlobalHouseRules(): string | null {
  return safeReadCapped(join(BRIDGE_LOGIC_DIR, "house-rules.md"));
}

export function loadAppHouseRules(appPath: string): string | null {
  if (!appPath) return null;
  return safeReadCapped(join(appPath, ".bridge", "house-rules.md"));
}

export function loadHouseRules(appPath: string | null): string | null {
  const global = loadGlobalHouseRules();
  const perApp = appPath ? loadAppHouseRules(appPath) : null;
  if (!global && !perApp) return null;
  const parts: string[] = [];
  if (global) {
    parts.push("### Global", "", global);
  }
  if (perApp) {
    if (parts.length > 0) parts.push("", "---", "");
    parts.push("### App-specific", "", perApp);
  }
  return parts.join("\n");
}
