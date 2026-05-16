/** Slash palette rows from `/api/repos/<name>/slash-commands`. */
export type SlashCommandsItemSource = "builtin" | "project" | "user";

export interface SlashCommandsItemDto {
  slug: string;
  description: string | null;
  source: SlashCommandsItemSource;
}

// `TaskStatus` / `TaskSection` / `Task` live in `libs/tasks.ts` (the
// server-side source of truth). Imported here so other interfaces in
// this file can reference them, then re-exported so existing client
// imports `from "@/libs/client/types"` keep working.
import type { Task, TaskStatus, TaskSection } from "../tasks";
import type { RunStatus } from "../runStatus";

export type { Task, TaskStatus, TaskSection, RunStatus };

export interface Run {
  sessionId: string;
  role: string;
  repo: string;          // folder name of the repo this run targets
  status: RunStatus;
  startedAt: string | null;
  endedAt: string | null;
  /**
   * (Phase B+) The coordinator session UUID that spawned this run via
   * `POST /api/tasks/<id>/agents`. `null` / absent means the run was
   * spawned directly by the bridge (e.g. it IS the coordinator), or
   * by a pre-Phase-B path. Phase C uses this to draw the agent tree.
   */
  parentSessionId?: string | null;
  /**
   * Set when the post-success integration merged locally but the
   * push to the remote failed. UI renders this as a yellow
   * "needs-push" badge so the operator notices the work hasn't
   * reached the remote yet. See server-side `Run.mergeNotPushed`
   * in libs/meta.ts for the authoritative shape.
   */
  mergeNotPushed?: {
    message: string;
    error: string | null;
    at: string;
  } | null;
}

export interface Meta {
  taskId: string;
  taskTitle: string;
  taskBody: string;
  taskStatus: TaskStatus;
  taskSection: TaskSection;
  taskChecked: boolean;
  createdAt: string;
  runs: Run[];
}

export interface Repo {
  name: string;          // folder name, authoritative
  path: string;
  exists: boolean;
  /** true only for the bridge itself */
  isBridge?: boolean;
  /** registered in `sessions/init.md` vs auto-discovered as a sibling folder */
  declared?: boolean;
  /** description from the apps registry (only set on registered repos) */
  description?: string;
  /** current git branch (null = not a git repo or read failed) */
  branch?: string | null;
}

export type GitBranchMode = "current" | "fixed" | "auto-create";
export type GitWorktreeMode = "disabled" | "enabled";
export type GitIntegrationMode = "none" | "auto-merge" | "pull-request";

export interface AppGitSettings {
  branchMode: GitBranchMode;
  fixedBranch: string;
  autoCommit: boolean;
  autoPush: boolean;
  /** (P4) `enabled` runs every spawned child in a private worktree. */
  worktreeMode: GitWorktreeMode;
  /**
   * Integration target branch — used when `integrationMode` is
   * `auto-merge` (local merge) or `pull-request` (devops agent opens
   * a PR/MR). Empty when `integrationMode === "none"`.
   */
  mergeTargetBranch: string;
  /**
   * What the bridge does with the agent's work branch after auto-commit:
   * `none` | `auto-merge` (local) | `pull-request` (gh/glab via devops).
   */
  integrationMode: GitIntegrationMode;
  /** Per-app override for the `git push` timeout (5_000–600_000 ms). */
  pushTimeoutMs?: number;
}

/**
 * Per-app verify contract — shell commands the bridge runs after a
 * child agent finishes. P1 surfaces these into the child prompt so the
 * agent self-checks before reporting; P2 will exec them and feed
 * failures into auto-retry.
 */
export interface AppVerify {
  test?: string;
  lint?: string;
  build?: string;
  typecheck?: string;
  format?: string;
}

/**
 * (P2b-2) Per-app opt-in agent-driven quality gates. Both default off
 * because each enabled flag costs an extra LLM spawn per task.
 */
export interface AppQuality {
  critic?: boolean;
  verifier?: boolean;
}

/**
 * (Gap 2) Per-gate retry budgets. Each gate has an independent attempt
 * counter, capped server-side at MAX_RETRY_PER_GATE. Default 1 = legacy
 * single-shot retry per gate.
 */
export interface AppRetry {
  crash?: number;
  verify?: number;
  claim?: number;
  preflight?: number;
  style?: number;
  semantic?: number;
}

export interface App {
  name: string;
  path: string;
  rawPath: string;
  description: string;
  git: AppGitSettings;
  verify: AppVerify;
  /**
   * (P3a) Files always injected into spawned children's prompts.
   * Paths relative to the app root.
   */
  pinnedFiles: string[];
  /**
   * (P3a) Override the default `[lib, utils, hooks, components/ui]`
   * symbol-index scan roots. Empty = use defaults.
   */
  symbolDirs: string[];
  /**
   * (P2b-2) Opt-in agent-driven post-exit quality gates. Empty object
   * = both gates off (the default).
   */
  quality: AppQuality;
  /**
   * (Gap 2) Per-gate retry budgets. Empty / missing = each gate uses
   * the default (1 attempt per gate).
   */
  retry: AppRetry;
}

export interface SessionSummary {
  sessionId: string;
  repo: string;          // folder name the session belongs to (its project dir)
  repoPath: string;      // absolute path on disk, surfaced for full-path grouping
  branch: string | null; // current git branch of the repo (null if not a git tree)
  isBridge: boolean;
  mtime: number;
  size: number;
  preview: string;
  link: { taskId: string; role: string } | null;
}

// SECTION_ORDER lives in `libs/tasks.ts` (single source of truth). Re-
// exported here for back-compat with existing UI imports.
export { SECTION_ORDER } from "../tasks";
import { SECTION_BLOCKED, SECTION_DOING, SECTION_DONE, SECTION_TODO } from "../tasks";

export const SECTION_LABEL: Record<TaskSection, string> = {
  [SECTION_TODO]: "Todo",
  [SECTION_DOING]: "Doing",
  [SECTION_BLOCKED]: "Blocked",
  [SECTION_DONE]: "Done",
};

export const STATUS_ORDER: TaskStatus[] = ["todo", "doing", "blocked", "done"];

export const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: "Todo",
  doing: "Doing",
  blocked: "Blocked",
  done: "Done",
};

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "auto"
  | "bypassPermissions"
  | "dontAsk";

export type EffortLevel = "low" | "medium" | "high" | "max";

export interface ChatSettings {
  mode?: PermissionMode;
  effort?: EffortLevel;
  model?: string;
}

/**
 * Auto-detect candidate as it travels over the SSE stream. Mirror of
 * `DetectCandidate` in `libs/apps.ts`; lifted here so the dialog can
 * type the parsed `event.data` payloads without importing server code.
 */
export interface DetectCandidate {
  name: string;
  rawPath: string;
  absolutePath: string;
  description: string;
  signals: string[];
  score: number;
  alreadyRegistered: boolean;
  isMonorepoChild: boolean;
}

/**
 * Public-facing shape of `libs/tunnels.ts#TunnelEntry`. Mirrored here
 * so the `/tunnels` page and the `api` client can type tunnel rows
 * without dragging server-only `child_process` imports into the bundle.
 */
export type TunnelStatus = "starting" | "running" | "error" | "stopped";
export type TunnelProvider = "localtunnel" | "ngrok";

export interface TunnelEntry {
  id: string;
  port: number;
  label?: string;
  subdomain?: string;
  provider: TunnelProvider;
  status: TunnelStatus;
  url?: string;
  error?: string;
  startedAt: string;
  endedAt?: string;
  log: string[];
}

/**
 * Per-provider availability snapshot — see `libs/tunnels#detectProviders`.
 * The Tunnels page uses these fields to render install / authtoken
 * affordances next to the provider select.
 */
export interface TunnelProviderStatus {
  provider: TunnelProvider;
  installed: boolean;
  version?: string;
  authtokenSet?: boolean;
  installable: boolean;
  hint?: string;
}

export interface TunnelInstallResult {
  ok: boolean;
  status: TunnelProviderStatus;
  log: string;
}

export type DetectEvent =
  | { type: "started"; roots: string[]; depth: number }
  | { type: "scanning"; root: string }
  | { type: "candidate"; candidate: DetectCandidate }
  | { type: "skipped"; path: string; reason: "not-a-repo" | "already-scanned" | "permission" | "max-dirs" }
  | { type: "done"; candidates: number; alreadyRegistered: number; scanned: number };

/** Per-model token totals out of `~/.claude/stats-cache.json`. */
export interface UsageModel {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUSD: number;
  contextWindow: number;
  maxOutputTokens: number;
}

/** Single quota window from `/api/oauth/usage`. */
export interface QuotaWindow {
  utilization: number;
  resetsAt: string | null;
}

/** Extra-usage / overage credit status. */
export interface ExtraUsage {
  isEnabled: boolean;
  monthlyLimit: number | null;
  usedCredits: number | null;
  utilization: number | null;
  currency: string | null;
}

/**
 * Live `/usage` panel — same data Anthropic returns to the CLI's
 * `/usage › Usage` tab and to claude.ai/settings/usage.
 * `weeklyClaudeDesign` is the server's `seven_day_omelette` codename.
 */
export interface QuotaPanel {
  fiveHour: QuotaWindow | null;
  weeklyAllModels: QuotaWindow | null;
  weeklySonnet: QuotaWindow | null;
  weeklyOpus: QuotaWindow | null;
  weeklyClaudeDesign: QuotaWindow | null;
  weeklyOauthApps: QuotaWindow | null;
  weeklyCowork: QuotaWindow | null;
  extraUsage: ExtraUsage | null;
  error: string | null;
  fetchedAt: string;
}

/** Server response for `/api/usage` — see `libs/usageStats.ts`. */
export interface UsageSnapshot {
  source: "stats-cache" | "missing";
  cacheUpdatedAt: string | null;
  lastComputedDate: string | null;
  totalSessions: number;
  totalMessages: number;
  firstSessionDate: string | null;
  modelUsage: Record<string, UsageModel>;
  dailyActivity: Array<{
    date: string;
    messageCount: number;
    sessionCount: number;
    toolCallCount: number;
  }>;
  dailyModelTokens: Array<{
    date: string;
    tokensByModel: Record<string, number>;
  }>;
  longestSession: {
    sessionId: string;
    duration: number;
    messageCount: number;
    timestamp: string;
  } | null;
  hourCounts: Record<string, number>;
  plan: { subscriptionType: string; rateLimitTier: string } | null;
  quota: QuotaPanel | null;
}
