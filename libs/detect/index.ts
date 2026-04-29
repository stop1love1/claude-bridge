/**
 * Public entry point for the detect layer.
 *
 * Caller-facing surface:
 *   - `detectScope(input)`        — run detection per the global mode
 *   - `getOrComputeScope(dir, …)` — read cache, falling back to detect
 *   - `refreshScope(dir, …)`      — clear cache, re-detect, persist
 *   - `loadDetectInput(repos, …)` — build a DetectInput from the live
 *                                   apps roster + cached profiles
 *
 * The mode (`auto` / `llm` / `heuristic`) lives at
 * `bridge.json.detect.source` (top-level, alongside `apps[]`). Default
 * is `auto` so a fresh install Just Works without API keys — auto
 * tries the LLM impl first, falls back to heuristic on any error.
 */

import { existsSync } from "node:fs";
import { BRIDGE_ROOT, readBridgeMd } from "../paths";
import { loadProfiles } from "../profileStore";
import { resolveRepos } from "../repos";
import { getManifestDetectSource, loadApps } from "../apps";
import { heuristicDetector } from "./heuristic";
import { detectWithLLM } from "./llm";
import { readScopeCache, writeScopeCache, clearScopeCache } from "./cache";
import {
  type DetectInput,
  type DetectSource,
  type DetectedScope,
} from "./types";

/**
 * Read the configured detect source. Wraps `getManifestDetectSource`
 * so callers don't have to import from `apps.ts` directly.
 */
export function getDetectSource(): DetectSource {
  return getManifestDetectSource();
}

/**
 * Run detection per the global mode. Always resolves — never throws.
 *
 * - `heuristic` → heuristic only
 * - `llm`       → LLM only; on failure, returns heuristic output but
 *                 stamped `confidence: "low"` so the coordinator knows
 *                 the LLM didn't actually weigh in
 * - `auto`      → LLM first, fall back to heuristic transparently
 */
export async function detectScope(input: DetectInput): Promise<DetectedScope> {
  const mode = getDetectSource();

  if (mode === "heuristic") {
    return heuristicDetector.detect(input);
  }

  const llmResult = await detectWithLLM(input).catch((err) => {
    console.warn("[detect] LLM impl threw:", (err as Error).message);
    return null;
  });

  if (llmResult) return llmResult;

  // LLM failed or disabled — heuristic fallback.
  const heuristicResult = await heuristicDetector.detect(input);
  if (mode === "llm") {
    // Operator asked for LLM specifically; flag the fallback so the UI
    // can surface "LLM detection unavailable" without changing the
    // dispatch behavior.
    return {
      ...heuristicResult,
      confidence: "low",
      reason: `${heuristicResult.reason} (llm fallback)`,
    };
  }
  return heuristicResult;
}

/**
 * Build a `DetectInput` from the live apps roster + cached profiles +
 * bridge.json capabilities. The single place all the wiring lives, so
 * callers (createTask, refresh route, agents route) don't have to
 * each replicate the lookup.
 *
 * `repos` defaults to the BRIDGE.md-declared list intersected with
 * disk-existing folders; pass an explicit list to override.
 */
export function loadDetectInput(opts: {
  taskBody: string;
  taskTitle?: string;
  repos?: string[];
  pinnedRepo?: string | null;
}): DetectInput {
  let repoList = opts.repos;
  if (!repoList) {
    const md = readBridgeMd();
    repoList = resolveRepos(md, BRIDGE_ROOT)
      .filter((r) => existsSync(r.path))
      .map((r) => r.name);
    if (repoList.length === 0) {
      // No BRIDGE.md → fall back to bridge.json apps directly.
      repoList = loadApps().map((a) => a.name);
    }
  }

  const profiles = loadProfiles()?.profiles ?? undefined;

  // Build a per-app capabilities map from `bridge.json.apps[].capabilities`.
  // Apps without declared capabilities simply don't appear in the map.
  const capabilities: Record<string, string[]> = {};
  for (const app of loadApps()) {
    if (app.capabilities && app.capabilities.length > 0) {
      capabilities[app.name] = app.capabilities;
    }
  }

  return {
    taskBody: opts.taskBody,
    taskTitle: opts.taskTitle,
    repos: repoList,
    profiles,
    capabilities: Object.keys(capabilities).length > 0 ? capabilities : undefined,
    pinnedRepo: opts.pinnedRepo ?? null,
  };
}

/**
 * Read the cached scope for a task; if the cache is stale or absent,
 * compute a fresh scope using the live input AND persist it. Used by
 * the coordinator + agents path so the same scope is read across many
 * spawns without re-running the LLM.
 *
 * Pass `forceRefresh: true` to skip the cache read (used by the
 * refresh API route).
 */
export async function getOrComputeScope(
  sessionsDir: string,
  inputBuilder: () => DetectInput,
  opts: { forceRefresh?: boolean } = {},
): Promise<DetectedScope> {
  if (!opts.forceRefresh) {
    const cached = readScopeCache(sessionsDir);
    if (cached) return cached;
  }
  const input = inputBuilder();
  const scope = await detectScope(input);
  // Best-effort persist — a write failure shouldn't block the spawn.
  await writeScopeCache(sessionsDir, scope).catch((err) => {
    console.warn("[detect] failed to persist scope cache:", (err as Error).message);
  });
  return scope;
}

/**
 * Drop the cached scope and re-run detection. Used by
 * `POST /api/tasks/<id>/detect/refresh`.
 */
export async function refreshScope(
  sessionsDir: string,
  inputBuilder: () => DetectInput,
): Promise<DetectedScope> {
  await clearScopeCache(sessionsDir);
  return getOrComputeScope(sessionsDir, inputBuilder, { forceRefresh: true });
}

// Re-exports so callers don't have to know about the file split.
export type {
  DetectInput,
  DetectedScope,
  DetectSource,
  RepoMatch,
} from "./types";
export { heuristicDetector } from "./heuristic";
export { renderDetectedScope } from "./render";
export { readScopeCache, writeScopeCache, clearScopeCache } from "./cache";
