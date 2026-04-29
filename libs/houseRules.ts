/**
 * House-rules loader (Phase 1 / item C3 of the agentic-coder roadmap).
 *
 * Two layers, both opt-in (missing = skip, no error):
 *
 *   - **Global** — `prompts/house-rules.md` in the bridge repo. Team-shared
 *     constraints that apply to every spawn regardless of target repo.
 *   - **Per-app** — `<appPath>/.bridge/house-rules.md` inside the sibling
 *     repo itself. Constraints specific to that codebase (committed by
 *     that repo's team, not the bridge maintainers).
 *
 * Both files are plain markdown — content is prepended verbatim to the
 * child prompt by `buildChildPrompt`. Pattern mirrors `safeReadText` in
 * `libs/repoProfile.ts`: synchronous read, fail-soft to `null`, capped at
 * a fixed byte budget so a runaway markdown file can't blow out the
 * child's context window.
 */
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

/**
 * Load both layers and merge into a single block ready to inject into
 * the child prompt. Returns `null` when neither file exists, so the
 * caller can skip rendering the section entirely.
 *
 * When both layers are present, the global block is rendered first,
 * separated from the per-app block by a horizontal rule and a labeled
 * subheading — this keeps the precedence visible to the agent (per-app
 * rules naturally override globals because they appear later and last
 * impressions win in long prompts).
 */
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
