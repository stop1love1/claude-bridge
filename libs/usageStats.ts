import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { USER_CLAUDE_DIR } from "./paths";

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUSD: number;
  contextWindow: number;
  maxOutputTokens: number;
}

export interface DailyActivity {
  date: string;
  messageCount: number;
  sessionCount: number;
  toolCallCount: number;
}

export interface DailyModelTokens {
  date: string;
  tokensByModel: Record<string, number>;
}

export interface LongestSession {
  sessionId: string;
  duration: number;
  messageCount: number;
  timestamp: string;
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
  modelUsage: Record<string, ModelUsage>;
  dailyActivity: DailyActivity[];
  dailyModelTokens: DailyModelTokens[];
  longestSession: LongestSession | null;
  hourCounts: Record<string, number>;
  plan: { subscriptionType: string; rateLimitTier: string } | null;
  quota: QuotaPanel | null;
}

const STATS_CACHE = join(USER_CLAUDE_DIR, "stats-cache.json");
const CREDENTIALS = join(USER_CLAUDE_DIR, ".credentials.json");

const TTL_OK_MS = 60_000;
const TTL_429_MS = 60_000;
const TTL_ERR_MS = 8_000;
const QUOTA_TIMEOUT_MS = 4_000;
let cache: { value: UsageSnapshot; expires: number } | null = null;

function readJsonSafe<T>(path: string): T | null {
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as T;
  } catch { return null; }
}

interface RawCredentials {
  claudeAiOauth?: {
    accessToken?: string;
    expiresAt?: number;
    subscriptionType?: string;
    rateLimitTier?: string;
  };
}

function readCredentials(): RawCredentials | null {
  return readJsonSafe<RawCredentials>(CREDENTIALS);
}

function readPlan(cred: RawCredentials | null): UsageSnapshot["plan"] {
  const o = cred?.claudeAiOauth;
  if (!o || typeof o.subscriptionType !== "string") return null;
  return {
    subscriptionType: o.subscriptionType,
    rateLimitTier: typeof o.rateLimitTier === "string" ? o.rateLimitTier : "",
  };
}

interface RawWindow { utilization?: number; resets_at?: string | null }
interface RawQuotaResponse {
  five_hour?: RawWindow | null;
  seven_day?: RawWindow | null;
  seven_day_sonnet?: RawWindow | null;
  seven_day_opus?: RawWindow | null;
  seven_day_omelette?: RawWindow | null;
  seven_day_oauth_apps?: RawWindow | null;
  seven_day_cowork?: RawWindow | null;
  extra_usage?: {
    is_enabled?: boolean;
    monthly_limit?: number | null;
    used_credits?: number | null;
    utilization?: number | null;
    currency?: string | null;
  } | null;
}

function asWindow(w: RawWindow | null | undefined): QuotaWindow | null {
  if (!w || typeof w.utilization !== "number") return null;
  return {
    utilization: w.utilization,
    resetsAt: typeof w.resets_at === "string" ? w.resets_at : null,
  };
}

const EMPTY_QUOTA = (error: string, fetchedAt: string): QuotaPanel => ({
  fiveHour: null,
  weeklyAllModels: null,
  weeklySonnet: null,
  weeklyOpus: null,
  weeklyClaudeDesign: null,
  weeklyOauthApps: null,
  weeklyCowork: null,
  extraUsage: null,
  error,
  fetchedAt,
});

async function fetchQuota(
  cred: RawCredentials | null,
  signal: AbortSignal,
): Promise<QuotaPanel> {
  const fetchedAt = new Date().toISOString();
  const token = cred?.claudeAiOauth?.accessToken;
  if (!token) {
    return EMPTY_QUOTA("no oauth token in ~/.claude/.credentials.json", fetchedAt);
  }
  const exp = cred?.claudeAiOauth?.expiresAt;
  if (typeof exp === "number" && exp < Date.now()) {
    return EMPTY_QUOTA("oauth token expired — re-run `claude /login`", fetchedAt);
  }
  try {
    const r = await fetch("https://api.anthropic.com/api/oauth/usage", {
      method: "GET",
      signal,
      headers: {
        "Authorization": `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": "2023-06-01",
        "User-Agent": "claude-bridge/1.0",
      },
    });
    if (!r.ok) {
      let detail = `HTTP ${r.status}`;
      let retryAfterMs: number | undefined;
      if (r.status === 429) {
        retryAfterMs = TTL_429_MS;
        const retryAfter = r.headers.get("retry-after");
        const sec = retryAfter ? parseInt(retryAfter, 10) : NaN;
        if (Number.isFinite(sec) && sec * 1000 > TTL_429_MS) {
          retryAfterMs = sec * 1000;
          detail += ` (retry in ${sec}s)`;
        } else {
          detail += " (rate-limited; retrying in 60s)";
        }
      }
      const out = EMPTY_QUOTA(`anthropic api: ${detail}`, fetchedAt);
      if (retryAfterMs) {
        (out as QuotaPanel & { _retryAfterMs?: number })._retryAfterMs = retryAfterMs;
      }
      return out;
    }
    const raw = (await r.json()) as RawQuotaResponse;
    const ex = raw.extra_usage ?? null;
    return {
      fiveHour: asWindow(raw.five_hour),
      weeklyAllModels: asWindow(raw.seven_day),
      weeklySonnet: asWindow(raw.seven_day_sonnet),
      weeklyOpus: asWindow(raw.seven_day_opus),
      weeklyClaudeDesign: asWindow(raw.seven_day_omelette),
      weeklyOauthApps: asWindow(raw.seven_day_oauth_apps),
      weeklyCowork: asWindow(raw.seven_day_cowork),
      extraUsage: ex
        ? {
            isEnabled: !!ex.is_enabled,
            monthlyLimit: typeof ex.monthly_limit === "number" ? ex.monthly_limit : null,
            usedCredits: typeof ex.used_credits === "number" ? ex.used_credits : null,
            utilization: typeof ex.utilization === "number" ? ex.utilization : null,
            currency: typeof ex.currency === "string" ? ex.currency : null,
          }
        : null,
      error: null,
      fetchedAt,
    };
  } catch (e) {
    return EMPTY_QUOTA(
      `anthropic api: ${(e as Error).message || "network error"}`,
      fetchedAt,
    );
  }
}

interface RawStatsCache {
  lastComputedDate?: string;
  dailyActivity?: DailyActivity[];
  dailyModelTokens?: DailyModelTokens[];
  modelUsage?: Record<string, ModelUsage>;
  totalSessions?: number;
  totalMessages?: number;
  longestSession?: LongestSession;
  firstSessionDate?: string;
  hourCounts?: Record<string, number>;
}

export async function readUsageSnapshot(force = false): Promise<UsageSnapshot> {
  const now = Date.now();
  if (!force && cache && cache.expires > now) return cache.value;

  let cacheUpdatedAt: string | null = null;
  try { cacheUpdatedAt = new Date(statSync(STATS_CACHE).mtimeMs).toISOString(); }
  catch { }

  const raw = readJsonSafe<RawStatsCache>(STATS_CACHE);
  const cred = readCredentials();
  const plan = readPlan(cred);

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), QUOTA_TIMEOUT_MS);
  const quota = await fetchQuota(cred, ctl.signal).finally(() => clearTimeout(timer));

  const value: UsageSnapshot = raw
    ? {
        source: "stats-cache",
        cacheUpdatedAt,
        lastComputedDate: raw.lastComputedDate ?? null,
        totalSessions: typeof raw.totalSessions === "number" ? raw.totalSessions : 0,
        totalMessages: typeof raw.totalMessages === "number" ? raw.totalMessages : 0,
        firstSessionDate: raw.firstSessionDate ?? null,
        modelUsage: raw.modelUsage ?? {},
        dailyActivity: Array.isArray(raw.dailyActivity) ? raw.dailyActivity : [],
        dailyModelTokens: Array.isArray(raw.dailyModelTokens) ? raw.dailyModelTokens : [],
        longestSession: raw.longestSession ?? null,
        hourCounts: raw.hourCounts ?? {},
        plan,
        quota,
      }
    : {
        source: "missing",
        cacheUpdatedAt: null,
        lastComputedDate: null,
        totalSessions: 0,
        totalMessages: 0,
        firstSessionDate: null,
        modelUsage: {},
        dailyActivity: [],
        dailyModelTokens: [],
        longestSession: null,
        hourCounts: {},
        plan,
        quota,
      };

  const retryAfterMs = (quota as QuotaPanel & { _retryAfterMs?: number })._retryAfterMs;
  if (retryAfterMs) delete (quota as QuotaPanel & { _retryAfterMs?: number })._retryAfterMs;
  const ttl = retryAfterMs ?? (quota.error ? TTL_ERR_MS : TTL_OK_MS);
  cache = { value, expires: now + ttl };
  return value;
}
