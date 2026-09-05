
import type {
  App,
  AppDispatch,
  AppGitSettings,
  AppMemory,
  AppQuality,
  AppRetry,
  AppRoleModels,
  AppVerify,
  BridgeManifest,
  GitBranchMode,
  GitIntegrationMode,
  GitWorktreeMode,
  SpeculativeAngle,
} from "./apps/types";
import {
  DEFAULT_APP_DISPATCH,
  DEFAULT_APP_MEMORY,
  DEFAULT_APP_RETRY,
  DEFAULT_GIT_SETTINGS,
  DEFAULT_QUALITY,
  DEFAULT_VERIFY,
  RECOMMENDED_GIT_SETTINGS,
  resolveCriticPanelSize,
  resolvePanelSize,
  semanticVerifierEnabled,
} from "./apps/types";

export type {
  App,
  AppDispatch,
  AppGitSettings,
  AppMemory,
  AppQuality,
  AppRetry,
  AppRoleModels,
  AppVerify,
  BridgeManifest,
  GitBranchMode,
  GitIntegrationMode,
  GitWorktreeMode,
  SpeculativeAngle,
};
export {
  DEFAULT_APP_DISPATCH,
  DEFAULT_APP_MEMORY,
  DEFAULT_APP_RETRY,
  DEFAULT_GIT_SETTINGS,
  DEFAULT_QUALITY,
  DEFAULT_VERIFY,
  RECOMMENDED_GIT_SETTINGS,
  resolveCriticPanelSize,
  resolvePanelSize,
  semanticVerifierEnabled,
};

import {
  isValidAppName,
  loadApps,
  parseApps,
  saveApps,
  serializeApps,
} from "./apps/manifest";

export { isValidAppName, loadApps, parseApps, saveApps, serializeApps };

import {
  addApp,
  applyRecommendedPreset,
  backfillAppVerifyIfEmpty,
  getApp,
  removeApp,
  renameApp,
  resolveAppFromRouteSegment,
  updateAppCapabilities,
  updateAppDescription,
  updateAppGitSettings,
  updateAppQuality,
  updateAppRetry,
  updateAppRoleModels,
  updateAppVerify,
} from "./apps/crud";
import type { AddAppFailure, AddAppResult, AppInput, RenameAppFailure } from "./apps/crud";

export {
  addApp,
  applyRecommendedPreset,
  backfillAppVerifyIfEmpty,
  getApp,
  removeApp,
  renameApp,
  resolveAppFromRouteSegment,
  updateAppCapabilities,
  updateAppDescription,
  updateAppGitSettings,
  updateAppQuality,
  updateAppRetry,
  updateAppRoleModels,
  updateAppVerify,
};
export type { AddAppFailure, AddAppResult, AppInput, RenameAppFailure };

import {
  getManifestDetectScanRoots,
  getManifestDetectSource,
  getManifestProfileSource,
  getManifestPublicUrl,
  getTunnelAutoStart,
  setManifestDetectScanRoots,
  setManifestDetectSource,
  setManifestProfileSource,
  setManifestPublicUrl,
  setTunnelAutoStart,
} from "./bridgeSettings";
import type {
  DetectManifestSource,
  ProfileManifestSource,
  TunnelAutoStart,
} from "./bridgeSettings";

export {
  getManifestDetectScanRoots,
  getManifestDetectSource,
  getManifestProfileSource,
  getManifestPublicUrl,
  getTunnelAutoStart,
  setManifestDetectScanRoots,
  setManifestDetectSource,
  setManifestProfileSource,
  setManifestPublicUrl,
  setTunnelAutoStart,
};
export type { DetectManifestSource, ProfileManifestSource, TunnelAutoStart };

import {
  DEFAULT_FORWARD_CHAT,
  DEFAULT_FORWARD_CHAT_FILTER,
  DEFAULT_FORWARD_CHAT_IMPORTANT_PATTERNS,
  DEFAULT_FORWARD_CHAT_MIN_CHARS,
  DEFAULT_NOTIFICATION_LEVEL,
  DEFAULT_TELEGRAM_SETTINGS,
  DEFAULT_TELEGRAM_USER_SETTINGS,
  getManifestTelegramSettings,
  setManifestTelegramSettings,
} from "./telegramSettings";
import type {
  TelegramForwardChat,
  TelegramForwardChatFilter,
  TelegramNotificationLevel,
  TelegramSettings,
  TelegramUserSettings,
} from "./telegramSettings";

export {
  DEFAULT_FORWARD_CHAT,
  DEFAULT_FORWARD_CHAT_FILTER,
  DEFAULT_FORWARD_CHAT_IMPORTANT_PATTERNS,
  DEFAULT_FORWARD_CHAT_MIN_CHARS,
  DEFAULT_NOTIFICATION_LEVEL,
  DEFAULT_TELEGRAM_SETTINGS,
  DEFAULT_TELEGRAM_USER_SETTINGS,
  getManifestTelegramSettings,
  setManifestTelegramSettings,
};
export type {
  TelegramForwardChat,
  TelegramForwardChatFilter,
  TelegramNotificationLevel,
  TelegramSettings,
  TelegramUserSettings,
};

import {
  autoDetectApps,
  detectAppCandidates,
} from "./repoDetect";
import type {
  AutoDetectResult,
  DetectCandidate,
  DetectEvent,
  DetectOptions,
} from "./repoDetect";

export { autoDetectApps, detectAppCandidates };
export type { AutoDetectResult, DetectCandidate, DetectEvent, DetectOptions };

