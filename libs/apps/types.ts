
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

export const DEFAULT_GIT_SETTINGS: AppGitSettings = {
  branchMode: "current",
  fixedBranch: "",
  autoCommit: false,
  autoPush: false,
  worktreeMode: "disabled",
  mergeTargetBranch: "",
  integrationMode: "none",
};

export const RECOMMENDED_GIT_SETTINGS: AppGitSettings = {
  branchMode: "auto-create",
  fixedBranch: "",
  autoCommit: true,
  autoPush: false,
  worktreeMode: "disabled",
  mergeTargetBranch: "",
  integrationMode: "none",
};

export interface AppVerify {
  test?: string;
  lint?: string;
  build?: string;
  typecheck?: string;
  format?: string;
}

export const DEFAULT_VERIFY: AppVerify = {};

export interface AppQuality {
  critic?: boolean;
  verifier?: boolean;
  verifierPanel?: number;
  criticPanel?: number;
}

export const DEFAULT_QUALITY: AppQuality = {};

export function semanticVerifierEnabled(app: Pick<App, "quality">): boolean {
  return app.quality?.verifier !== false;
}

const DEFAULT_PANEL_SIZE = 3;

function clampPanelSize(configured: number | undefined, availableJudges: number): number {
  const ceiling = Number.isFinite(availableJudges)
    ? Math.max(1, Math.floor(availableJudges))
    : 1;
  if (typeof configured !== "number" || !Number.isFinite(configured)) {
    return Math.min(DEFAULT_PANEL_SIZE, ceiling);
  }
  return Math.max(1, Math.min(ceiling, Math.floor(configured)));
}

export function resolvePanelSize(
  app: Pick<App, "quality">,
  availableJudges: number,
): number {
  return clampPanelSize(app.quality?.verifierPanel, availableJudges);
}

export function resolveCriticPanelSize(
  app: Pick<App, "quality">,
  availableJudges: number,
): number {
  return clampPanelSize(app.quality?.criticPanel, availableJudges);
}

export interface AppRetry {
  crash?: number;
  verify?: number;
  claim?: number;
  preflight?: number;
  style?: number;
  semantic?: number;
  totalCap?: number;
}

export const DEFAULT_APP_RETRY: AppRetry = {};

export interface AppMemory {
  distill?: boolean;
}

export const DEFAULT_APP_MEMORY: AppMemory = {};

export interface AppDispatch {
  speculative?: {
    enabled?: boolean;
    n?: number;
    roles?: string[];
    angles?: SpeculativeAngle[];
  };
}

export interface SpeculativeAngle {
  label: string;
  nudge: string;
}

export const DEFAULT_APP_DISPATCH: AppDispatch = {};

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
  memory: AppMemory;
  dispatch: AppDispatch;
  capabilities: string[];
}

export interface ManifestAppEntry {
  name: string;
  path: string;
  description?: string;
  git?: Partial<AppGitSettings>;
  verify?: AppVerify;
  pinnedFiles?: string[];
  symbolDirs?: string[];
  quality?: AppQuality;
  capabilities?: string[];
  retry?: AppRetry;
  memory?: AppMemory;
  dispatch?: AppDispatch;
}

export interface BridgeManifest {
  version: number;
  apps: ManifestAppEntry[];
  [key: string]: unknown;
}
