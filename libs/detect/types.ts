import type { RepoProfile } from "../repoProfile";

export interface RepoMatch {
  name: string;
  score: number;
  reason: string;
}

export interface DetectedScope {
  repos: RepoMatch[];
  features: string[];
  entities: string[];
  files: string[];
  confidence: "high" | "medium" | "low";
  source: "llm" | "heuristic" | "user-pinned";
  detectedAt: string;
  reason: string;
}

export interface DetectInput {
  taskBody: string;
  taskTitle?: string;
  repos: string[];
  profiles?: Record<string, RepoProfile>;
  capabilities?: Record<string, string[]>;
  pinnedRepo?: string | null;
}

export interface Detector {
  detect(input: DetectInput): Promise<DetectedScope>;
}

export type DetectSource = "auto" | "llm" | "heuristic";

export interface DetectedScopeCacheEntry {
  taskBodyHash: string;
  scope: DetectedScope;
}

export function emptyScope(reason: string): DetectedScope {
  return {
    repos: [],
    features: [],
    entities: [],
    files: [],
    confidence: "low",
    source: "heuristic",
    detectedAt: new Date().toISOString(),
    reason,
  };
}
