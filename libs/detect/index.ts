
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

export function getDetectSource(): DetectSource {
  return getManifestDetectSource();
}

export async function detectScope(input: DetectInput): Promise<DetectedScope> {
  const mode = getDetectSource();

  if (mode === "heuristic") {
    return heuristicDetector.detect(input);
  }

  const llmResult = await detectWithLLM(input).catch((err) => {
    logWarn("detect", "LLM impl threw", { error: (err as Error).message });
    return null;
  });

  if (llmResult) return llmResult;

  const heuristicResult = await heuristicDetector.detect(input);
  if (mode === "llm") {
    return {
      ...heuristicResult,
      confidence: "low",
      reason: `${heuristicResult.reason} (llm fallback)`,
    };
  }
  return heuristicResult;
}

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
      repoList = loadApps().map((a) => a.name);
    }
  }

  const profiles = loadProfiles()?.profiles ?? undefined;

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
  await writeScopeCache(sessionsDir, scope).catch((err) => {
    logWarn("detect", "failed to persist scope cache", { error: (err as Error).message });
  });
  return scope;
}

export async function refreshScope(
  sessionsDir: string,
  inputBuilder: () => DetectInput,
): Promise<DetectedScope> {
  await clearScopeCache(sessionsDir);
  return getOrComputeScope(sessionsDir, inputBuilder, { forceRefresh: true });
}

export type {
  DetectInput,
  DetectedScope,
  DetectSource,
  RepoMatch,
} from "./types";
import { logWarn } from "../log";
export { heuristicDetector } from "./heuristic";
export { renderDetectedScope } from "./render";
export { readScopeCache, writeScopeCache, clearScopeCache } from "./cache";
