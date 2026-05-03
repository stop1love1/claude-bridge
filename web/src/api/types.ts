// Domain types used by the SPA. The auto-generated `schema.ts` carries
// the request/path surface but its response bodies are still v0.1
// `OkResponse` placeholders, so we re-declare the concrete shapes the
// Go bridge actually emits (mirrors internal/meta/{meta,tasks}.go and
// the Next libs/meta.ts the bridge round-trips).

// ---- Tasks --------------------------------------------------------------

export type RunStatus =
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "stale";

export type TaskStatus = "todo" | "doing" | "blocked" | "done";

export type TaskSection =
  | "TODO"
  | "DOING"
  | "BLOCKED"
  | "DONE — not yet archived";

export const SECTIONS: TaskSection[] = [
  "TODO",
  "DOING",
  "BLOCKED",
  "DONE — not yet archived",
];

export const SECTION_ORDER: TaskSection[] = SECTIONS;

export const SECTION_LABEL: Record<TaskSection, string> = {
  TODO: "Todo",
  DOING: "Doing",
  BLOCKED: "Blocked",
  "DONE — not yet archived": "Done",
};

export const STATUS_ORDER: TaskStatus[] = ["todo", "doing", "blocked", "done"];

export const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: "Todo",
  doing: "Doing",
  blocked: "Blocked",
  done: "Done",
};

// Sub-types for verifier rows — kept loose because the SPA never reads
// them today. Preserved as `unknown`-shaped objects so future panels
// can pull them out without a type churn.
export interface RunVerify {
  status?: string;
  log?: string;
  [key: string]: unknown;
}
export interface RunVerifier {
  status?: string;
  log?: string;
  [key: string]: unknown;
}
export interface RunStyleCritic {
  status?: string;
  log?: string;
  [key: string]: unknown;
}
export interface RunSemanticVerifier {
  status?: string;
  log?: string;
  [key: string]: unknown;
}

export interface Run {
  sessionId: string;
  role: string;
  repo: string;
  status: RunStatus;
  startedAt: string | null;
  endedAt: string | null;
  parentSessionId?: string | null;
  retryOf?: string | null;
  retryAttempt?: number | null;
  verify?: RunVerify | null;
  verifier?: RunVerifier | null;
  styleCritic?: RunStyleCritic | null;
  semanticVerifier?: RunSemanticVerifier | null;
  worktreePath?: string | null;
  worktreeBranch?: string | null;
  worktreeBaseBranch?: string | null;
  exitCode?: number | null;
  speculativeGroup?: string | null;
  speculativeOutcome?: string | null;
}

/**
 * Lite task header shape returned by GET /api/tasks. The Go
 * `metaToTask` projection strips runs and synthesizes the `date`
 * prefix (`YYYY-MM-DD`) from the task id.
 */
export interface Task {
  id: string;
  date: string;
  title: string;
  body: string;
  status: TaskStatus;
  section: TaskSection;
  checked: boolean;
  /** Target app name; `null` means "auto" (coordinator decides). */
  app?: string | null;
}

export interface TaskMeta {
  taskId: string;
  taskTitle: string;
  taskBody: string;
  taskStatus: TaskStatus;
  taskSection: TaskSection;
  taskChecked: boolean;
  taskApp?: string | null;
  createdAt: string;
  runs: Run[];
  /** Detect-cache opaque payload — keyed by the detect package. */
  detectedScope?: unknown;
}

/** Alias for the legacy `Meta` name from main. */
export type Meta = TaskMeta;

/**
 * The Go handler emits the meta map keyed by task id (mirrors the
 * Next handler). We expose both the keyed map AND a normalized
 * `{tasks: TaskMeta[]}` form for callers that only want the array.
 */
export type TaskMetaMap = Record<string, TaskMeta>;

export interface TaskMetaList {
  tasks: TaskMeta[];
}

export type CreateTaskBody = {
  title?: string;
  body: string;
  app?: string | null;
};

export type PatchTaskBody = Partial<{
  title: string;
  body: string;
  section: TaskSection;
  status: TaskStatus;
  checked: boolean;
}>;

export interface DeleteTaskResponse {
  ok: boolean;
  sessionsDeleted: number;
  sessionsFailed: number;
}

export interface AgentSpawnBody {
  role: string;
  // `repo` and `prompt` are optional at the wire level — the Go
  // handler tolerates empty string defaults when the coordinator
  // hasn't picked a target yet.
  repo?: string;
  prompt?: string;
  parentSessionId?: string;
  allowDuplicate?: boolean;
  /** `spawn` (fresh child) or `resume` (continuation turn). */
  mode?: "spawn" | "resume";
}

export interface AgentSpawnResponse {
  sessionId?: string;
  pid?: number;
  /** Server-side error attached to a 200 (e.g. coordinator misconfig). */
  error?: string;
  [key: string]: unknown;
}

export interface ContinueTaskResponse {
  action: "resumed" | "spawned";
  sessionId?: string;
  [key: string]: unknown;
}

export interface ClearTaskResponse {
  action: "spawned";
  sessionId: string;
  [key: string]: unknown;
}

export interface LinkSessionBody {
  sessionId: string;
  role?: string;
  repo?: string;
  status?: RunStatus | string;
}

export interface LinkSessionResponse {
  ok: boolean;
  inserted?: boolean;
}

export interface RunPromptResponse {
  prompt: string;
  /** Present when the Go bridge is running with the deferred prompt path. */
  note?: string;
}

export interface RunDiffResponse {
  kind: "worktree" | "live";
  cwd: string;
  diff: string;
  truncated?: boolean;
  repo?: string;
  branch?: string | null;
}

export interface KillRunResponse {
  sessionId: string;
  action: "killed";
}

export interface DetectRefreshResponse {
  ok: boolean;
  [key: string]: unknown;
}

// ---- Sessions -----------------------------------------------------------

export interface SessionLink {
  taskId: string;
  role: string;
}

export interface SessionSummary {
  sessionId: string;
  /** Folder name the session belongs to (its project dir). */
  repo: string;
  /** Absolute path on disk, surfaced for full-path grouping. */
  repoPath: string;
  /** Current git branch of the repo (null if not a git tree). */
  branch: string | null;
  isBridge: boolean;
  mtime: number;
  size: number;
  preview: string;
  link: SessionLink | null;
}

/**
 * Each line in a session .jsonl. Shape varies (system prompt, user
 * turn, assistant turn, tool block, …). Callers hand the raw object
 * to the renderer rather than typing every variant.
 */
export type SessionMessage = Record<string, unknown> & {
  uuid?: string;
  type?: string;
  role?: string;
  timestamp?: string;
};

export interface SessionTailForward {
  lines: SessionMessage[];
  offset: number;
  lineOffsets: number[];
}

export interface SessionTailBackward {
  lines: SessionMessage[];
  fromOffset: number;
  beforeOffset: number;
  lineOffsets: number[];
}

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
  allowedTools?: string[];
  disallowedTools?: string[];
}

export interface SessionMessageBody {
  message: string;
  repo: string;
  settings?: ChatSettings;
}

export interface SessionMessageResponse {
  sessionId: string;
  pid?: number;
}

export interface SessionRewindBody {
  repo: string;
  uuid: string;
}

export interface SessionRewindResponse {
  kept: number;
  dropped: number;
}

export interface SessionKillResponse {
  ok?: boolean;
  sessionId?: string;
  action?: "killed";
}

// ---- Apps + Repos -------------------------------------------------------

export type GitBranchMode = "current" | "fixed" | "auto-create";
export type GitWorktreeMode = "disabled" | "enabled";
export type GitIntegrationMode = "none" | "auto-merge" | "pull-request";

export interface AppGitSettings {
  branchMode: GitBranchMode;
  fixedBranch: string;
  autoCommit: boolean;
  autoPush: boolean;
  worktreeMode?: GitWorktreeMode;
  mergeTargetBranch?: string;
  integrationMode?: GitIntegrationMode;
}

export interface AppVerify {
  test?: string;
  lint?: string;
  build?: string;
  typecheck?: string;
  format?: string;
}

export interface AppQuality {
  critic?: boolean;
  verifier?: boolean;
}

/**
 * Per-gate retry budgets. Every key is optional — missing means
 * "use the bridge default" (1 attempt per gate).
 */
export interface AppRetry {
  crash?: number;
  verify?: number;
  claim?: number;
  preflight?: number;
  style?: number;
  semantic?: number;
}

export type AppExtras = Record<string, unknown>;

export interface App {
  name: string;
  path: string;
  rawPath?: string;
  description?: string;
  git?: AppGitSettings;
  verify?: AppVerify;
  pinnedFiles?: string[];
  symbolDirs?: string[];
  quality?: AppQuality;
  retry?: AppRetry;
  extras?: AppExtras;
}

/** Lighter alias the existing dashboard pages already use. */
export interface AppEntry {
  name: string;
  path?: string;
  branchMode?: GitBranchMode;
  fixedBranch?: string;
  autoCommit?: boolean;
  autoPush?: boolean;
}

export interface AppsResponse {
  apps: App[];
}

export interface AddAppBody {
  name: string;
  path: string;
  description?: string;
}

export type BulkAddAppEntry = AddAppBody;

export interface AppMemoryResponse {
  memory: string;
  entries: string[];
}

export interface AppendAppMemoryBody {
  entry: string;
}

export interface AppendAppMemoryResponse {
  memory: string;
  appended: boolean;
}

export interface ScanAppResponse {
  ok: boolean;
  symbolCount?: number;
  styleSampledFiles?: string[];
  profile?: RepoProfile | null;
}

export interface AutoDetectResponse {
  /** Stub today — Go server returns `{candidates: [], deferred: "..."}`. */
  candidates: DetectCandidate[];
  deferred?: string;
}

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

/** Detection lifecycle event over SSE (see /api/tasks/{id}/events). */
export type DetectEvent =
  | { type: "started"; roots: string[]; depth: number }
  | { type: "scanning"; root: string }
  | { type: "candidate"; candidate: DetectCandidate }
  | {
      type: "skipped";
      path: string;
      reason: "not-a-repo" | "already-scanned" | "permission" | "max-dirs";
    }
  | { type: "done"; candidates: number; alreadyRegistered: number; scanned: number };

// Repos resolver -----------------------------------------------------

export interface Repo {
  name: string;
  path: string;
  exists?: boolean;
  isBridge?: boolean;
  declared?: boolean;
  description?: string;
  branch?: string | null;
}

export interface ReposResponse {
  repos: Repo[];
}

export interface RepoFileEntry {
  name: string;
  type: "file" | "dir";
  size: number;
  mtime: string;
}

export interface RepoFilesResponse {
  entries: RepoFileEntry[];
}

export interface RepoRawFileResponse {
  path: string;
  content: string;
  size: number;
  truncated: boolean;
}

export type SlashCommandsItemSource = "builtin" | "project" | "user";

export interface SlashCommandsItemDto {
  slug: string;
  description: string | null;
  source: SlashCommandsItemSource;
}

export interface SlashCommandsResponse {
  items: SlashCommandsItemDto[];
}

/** Cached repo-profile entry produced by the detect pipeline. */
export interface RepoProfile {
  name: string;
  path?: string;
  description?: string;
  framework?: string;
  language?: string;
  signals?: string[];
  detectedAt?: string;
  [key: string]: unknown;
}

export interface RepoProfilesResponse {
  profiles: RepoProfile[];
}

export interface RefreshRepoProfilesResponse {
  refreshed: number;
  profiles: RepoProfile[];
}

/** File-search row returned by the legacy fuzzy-files endpoint. */
export interface FileSearchResult {
  rel: string;
  path: string;
}

// ---- Tunnels ------------------------------------------------------------

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

export interface TunnelsResponse {
  tunnels: TunnelEntry[];
}

export interface CreateTunnelBody {
  port: number;
  provider: TunnelProvider;
  label?: string;
  subdomain?: string;
}

export interface CreateTunnelResponse {
  tunnel: TunnelEntry;
}

export interface TunnelProviderStatus {
  provider: TunnelProvider;
  installed: boolean;
  version?: string;
  authtokenSet?: boolean;
  installable: boolean;
  hint?: string;
}

export interface TunnelProvidersResponse {
  providers: TunnelProviderStatus[];
}

export interface TunnelInstallResult {
  ok: boolean;
  status?: TunnelProviderStatus;
  log?: string;
}

export interface NgrokAuthtokenResponse {
  token: string;
}

export interface SetNgrokAuthtokenBody {
  /**
   * The Go handler accepts the field as `token` (matches
   * SetNgrokAuthtokenBody in internal/api/tunnels.go); main's TS
   * version used `authtoken`. Senders should pass either field —
   * the client wrapper accepts an `authtoken` shorthand too.
   */
  token: string;
}

// ---- Permission ---------------------------------------------------------

export type PermissionDecision = "allow" | "deny";
export type PermissionResponseStatus = "pending" | PermissionDecision;

export interface PermissionRequest {
  sessionId: string;
  requestId: string;
  tool: string;
  input: unknown;
  status?: PermissionResponseStatus;
  decision?: PermissionDecision | null;
  reason?: string | null;
  createdAt: string;
  decidedAt?: string | null;
}

export interface PermissionPendingResponse {
  pending: PermissionRequest[];
}

export interface AnnouncePermissionBody {
  sessionId: string;
  requestId: string;
  tool: string;
  input?: unknown;
}

export interface AnswerPermissionBody {
  decision: PermissionDecision;
  reason?: string;
}

// ---- Upload -------------------------------------------------------------

export interface UploadResponse {
  path: string;
  name: string;
  size: number;
  url?: string;
  mime?: string | null;
}

// ---- Misc / Bridge / Usage / Health ------------------------------------

export interface HealthResponse {
  status: "ok";
  version?: string;
  uptime?: number;
}

/**
 * `bridge.json` is freeform — the Go handler echoes the raw bytes.
 * We type the well-known fields and leave the rest open.
 */
export interface BridgeSettings {
  publicUrl?: string;
  [key: string]: unknown;
}

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

export interface QuotaWindow {
  utilization: number;
  resetsAt: string | null;
}

export interface ExtraUsage {
  isEnabled: boolean;
  monthlyLimit: number | null;
  usedCredits: number | null;
  utilization: number | null;
  currency: string | null;
}

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

export interface UsageDailyActivity {
  date: string;
  messageCount: number;
  sessionCount: number;
  toolCallCount: number;
}

export interface UsageDailyModelTokens {
  date: string;
  tokensByModel: Record<string, number>;
}

export interface UsageLongestSession {
  sessionId: string;
  duration: number;
  messageCount: number;
  timestamp: string;
}

export interface UsageSnapshot {
  source: "stats-cache" | "missing";
  cacheUpdatedAt: string | null;
  lastComputedDate: string | null;
  totalSessions: number;
  totalMessages: number;
  firstSessionDate: string | null;
  modelUsage: Record<string, UsageModel>;
  dailyActivity: UsageDailyActivity[];
  dailyModelTokens: UsageDailyModelTokens[];
  longestSession: UsageLongestSession | null;
  hourCounts: Record<string, number>;
  plan: { subscriptionType: string; rateLimitTier: string } | null;
  quota: QuotaPanel | null;
}

/**
 * Loose response — the Go usage handler still emits the legacy
 * `{totals, perTask}` shape on some paths and the snapshot above on
 * others. Callers can narrow with `in` checks.
 */
export type UsageResponse =
  | UsageSnapshot
  | {
      totals?: {
        inputTokens?: number;
        outputTokens?: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
        cost?: number;
      };
      perTask?: Record<string, unknown>;
    };

/** Per-task usage from /api/tasks/{id}/usage. Mirrors taskUsageResponse. */
export interface PerRunUsage {
  sessionId: string;
  role: string;
  repo: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  turns: number;
}

export interface TaskUsageResponse {
  taskId: string;
  total: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    turns: number;
  };
  runs: PerRunUsage[];
}
