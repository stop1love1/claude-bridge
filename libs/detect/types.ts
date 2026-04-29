/**
 * Standardized contract for "given a task body, decide which repo(s) to
 * touch and what features / files / entities are in scope". One type
 * shape across heuristic + LLM impls + cache + render layers.
 *
 * Replaces the ad-hoc trio:
 *   - `libs/repoHeuristic.suggestRepo` (pick repo)
 *   - `libs/repoProfile.FEATURE_RULES` (pick features per repo)
 *   - `libs/contextAttach.attachReferences` (pick relevant files)
 *
 * with a single detection pass whose result is cached in
 * `sessions/<task-id>/meta.json` and rendered identically into both the
 * coordinator prompt and every child prompt — no drift between the two.
 */
import type { RepoProfile } from "../repoProfile";

/** A candidate repo with its score + why it scored that high. */
export interface RepoMatch {
  name: string;
  /** Higher = better match. Compare within one DetectedScope only;
   *  scores aren't comparable across detector impls. */
  score: number;
  /** Human-readable reason — surfaced in the coordinator prompt. */
  reason: string;
}

/**
 * The single output shape every detector impl must return. Persisted to
 * `meta.json` and rendered into prompts — additive changes only, never
 * remove or rename fields once shipped.
 */
export interface DetectedScope {
  /** Sorted by score descending. `repos[0]` is the dispatch target. */
  repos: RepoMatch[];
  /**
   * High-level features the task touches, intersected with the union of
   * declared `app.capabilities` from `bridge.json`. Lowercased,
   * deduped. Empty array = no clear feature signal.
   */
  features: string[];
  /**
   * Domain entities mentioned in the task body (e.g. "course", "lesson",
   * "student"). Bilingual: includes both the original-language token
   * AND its English/canonical form when the LLM impl can map it.
   */
  entities: string[];
  /**
   * Specific file paths or globs the task body explicitly references.
   * Empty when the task is feature-shaped rather than file-shaped.
   */
  files: string[];
  /**
   * - `high`   — LLM call succeeded with a clear winner.
   * - `medium` — heuristic top-1 with a margin over runner-up.
   * - `low`    — heuristic with no clear winner, OR LLM failed and we
   *              fell back. Coordinator should weigh task body before
   *              trusting `repos[0]`.
   */
  confidence: "high" | "medium" | "low";
  /**
   * Which impl produced this result. `user-pinned` = the user explicitly
   * picked the repo via the NewSessionDialog — detector still ran for
   * features/entities/files, but `repos[0]` is the user's pick.
   */
  source: "llm" | "heuristic" | "user-pinned";
  /** ISO timestamp when this scope was computed. */
  detectedAt: string;
  /**
   * One-line summary for logs / UI tooltips. Detector-specific phrasing
   * — heuristic shows top-keyword hits, LLM shows the model's reasoning.
   */
  reason: string;
}

/** Input handed to every detector impl. */
export interface DetectInput {
  /** Task body — primary signal. Must be the user's verbatim text. */
  taskBody: string;
  /**
   * Task title — secondary signal. Often more concise than the body and
   * useful when the body is verbose / multi-paragraph.
   */
  taskTitle?: string;
  /** Allowlist of repo names — only these can win. */
  repos: string[];
  /**
   * Cached repo profiles (`libs/profileStore`). Required for any impl to
   * score above zero — without profile data there's no signal.
   */
  profiles?: Record<string, RepoProfile>;
  /**
   * Per-app declared capabilities (`bridge.json.apps[].capabilities`).
   * Free-form tags like `["lms.course", "lms.lesson", "auth.login"]`.
   * Replaces / supplements heuristic feature inference.
   */
  capabilities?: Record<string, string[]>;
  /**
   * Repo the user pinned via the NewSessionDialog. When set, detector
   * still runs but `source: "user-pinned"` and `repos[0].name === pinnedRepo`.
   */
  pinnedRepo?: string | null;
}

/** Detector contract — heuristic + LLM impls implement this. */
export interface Detector {
  detect(input: DetectInput): Promise<DetectedScope>;
}

/**
 * Global detection mode, persisted at `bridge.json.detect.source`:
 *   - `auto`      — try LLM, fall back to heuristic on error / disabled
 *   - `llm`       — LLM only; on error, return heuristic result with
 *                   `confidence: "low"` (never block dispatch)
 *   - `heuristic` — never call LLM; pure local detection
 *
 * Default `auto` so a fresh install Just Works without an API key
 * (auto recognises the missing key and degrades to heuristic).
 */
export type DetectSource = "auto" | "llm" | "heuristic";

/**
 * Cache entry persisted under `meta.detectedScope`. The hash lets us
 * detect when the cached scope was computed against an outdated task
 * body — `cache.ts` treats a hash mismatch as "no cache" so the
 * coordinator/child path falls back to live detection.
 */
export interface DetectedScopeCacheEntry {
  taskBodyHash: string;
  scope: DetectedScope;
}

/** Default empty-result placeholder when detection genuinely has no signal. */
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
