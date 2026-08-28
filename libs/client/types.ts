export type SlashCommandsItemSource = "builtin" | "project" | "user";

export interface SlashCommandsItemDto {
  slug: string;
  description: string | null;
  source: SlashCommandsItemSource;
}

import type { Task, TaskStatus, TaskSection } from "../tasks";
import type { RunStatus } from "../runStatus";
import type { GateStatus, GateStatusEntry, GateVerdict } from "../gateStatus";

export type { Task, TaskStatus, TaskSection, RunStatus, GateStatus, GateStatusEntry, GateVerdict };

export interface Run {
  sessionId: string;
  role: string;
  repo: string;
  repoPath?: string | null;
  status: RunStatus;
  startedAt: string | null;
  endedAt: string | null;
  parentSessionId?: string | null;
  mergeNotPushed?: {
    message: string;
    error: string | null;
    at: string;
  } | null;
  semanticVerifier?: {
    verdict: "pass" | "drift" | "broken" | "skipped";
    reason: string;
    panelSize?: number;
    votes?: Array<{ lens: string; verdict: "pass" | "drift" | "broken"; reason: string }>;
  } | null;
  confidence?: {
    score: number;
    band: "high" | "medium" | "low";
    heldAt?: string | null;
    reviewedBy?: { label: string; at: string } | null;
  } | null;
}

export type IntakeStatus = "none" | "planning" | "awaiting-approval" | "approved" | "error";
export interface IntakeQuestion {
  id: string;
  text: string;
  options?: string[];
  recommended?: string;
}
export interface TaskIntake {
  status: IntakeStatus;
  verdict: "clear" | "needs-decision" | "unknown" | null;
  summary: string | null;
  questions: IntakeQuestion[];
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
  intake?: TaskIntake | null;
}

export interface Repo {
  name: string;
  path: string;
  exists: boolean;
  isBridge?: boolean;
  declared?: boolean;
  description?: string;
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
  worktreeMode: GitWorktreeMode;
  mergeTargetBranch: string;
  integrationMode: GitIntegrationMode;
  pushTimeoutMs?: number;
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
  pinnedFiles: string[];
  symbolDirs: string[];
  quality: AppQuality;
  retry: AppRetry;
}

export interface SessionSummary {
  sessionId: string;
  repo: string;
  repoPath: string;
  branch: string | null;
  isBridge: boolean;
  mtime: number;
  size: number;
  preview: string;
  link: { taskId: string; role: string } | null;
}

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

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max" | "ultracode";

export interface ChatSettings {
  mode?: PermissionMode;
  effort?: EffortLevel;
  model?: string;
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

export type TunnelStatus = "starting" | "running" | "error" | "stopped";
// Sourced from the dependency-free module the server validates against, so the
// client union cannot drift from it.
import type { TunnelProvider } from "../tunnelProvider";
export type { TunnelProvider };

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

export interface TunnelAutoStart {
  enabled: boolean;
  provider: TunnelProvider;
  port: number;
}

export type DetectEvent =
  | { type: "started"; roots: string[]; depth: number }
  | { type: "scanning"; root: string }
  | { type: "candidate"; candidate: DetectCandidate }
  | { type: "skipped"; path: string; reason: "not-a-repo" | "already-scanned" | "permission" | "max-dirs" }
  | { type: "done"; candidates: number; alreadyRegistered: number; scanned: number };

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
