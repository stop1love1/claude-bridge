
import { spawn } from "node:child_process";
import { loadAuthConfig, pruneExpired, writeRuntimeMeta } from "./auth";
import {
  getManifestTelegramSettings,
  loadApps,
} from "./apps";
import { BRIDGE_PORT, BRIDGE_URL } from "./paths";
import { clearSetupToken, ensureSetupToken } from "./setupToken";
import { acquireProcessLock } from "./processLock";
import { logError, logInfo, logWarn } from "./log";

type CheckStatus = "ok" | "configured" | "missing" | "warn" | "error";

interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const TG_HOST = "https://api.telegram.org";
const TG_TIMEOUT_MS = 4000;
const CLAUDE_TIMEOUT_MS = 5000;

function probeClaude(): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const finish = (val: string | null) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    let child;
    try {
      child = spawn(CLAUDE_BIN, ["--version"], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      finish(null);
      return;
    }
    const timer = setTimeout(() => {
      try { child?.kill("SIGKILL"); } catch { }
      finish(null);
    }, CLAUDE_TIMEOUT_MS);
    child.on("error", () => {
      clearTimeout(timer);
      finish(null);
    });
    child.stdout?.on("data", (c: Buffer) => { stdout += c.toString("utf8"); });
    child.stderr?.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
    child.on("close", () => {
      clearTimeout(timer);
      const combined = (stdout || stderr).trim();
      if (!combined) {
        finish(null);
        return;
      }
      const first = combined.split(/\r?\n/).find((l) => l.trim()) ?? "";
      finish(first.trim() || null);
    });
  });
}

async function checkClaudeCli(): Promise<CheckResult> {
  const version = await probeClaude();
  if (!version) {
    return {
      name: "claude-cli",
      status: "error",
      detail: `\`${CLAUDE_BIN}\` not found on PATH or returned no version (set CLAUDE_BIN to override)`,
    };
  }
  return {
    name: "claude-cli",
    status: "ok",
    detail: `${CLAUDE_BIN} → ${version}`,
  };
}

async function checkTelegramBot(): Promise<CheckResult> {
  const { botToken, chatId } = getManifestTelegramSettings();
  if (!botToken || !chatId) {
    if (botToken || chatId) {
      return {
        name: "telegram-bot",
        status: "warn",
        detail: `partially configured (botToken=${botToken ? "set" : "missing"}, chatId=${chatId ? "set" : "missing"})`,
      };
    }
    return { name: "telegram-bot", status: "missing", detail: "not configured" };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TG_TIMEOUT_MS);
  try {
    const r = await fetch(`${TG_HOST}/bot${botToken}/getMe`, {
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const rawBody = await r.text().catch(() => "");
      const safeBody = rawBody
        .split(botToken).join("[redacted]")
        .replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot[redacted]");
      return {
        name: "telegram-bot",
        status: "error",
        detail: `getMe HTTP ${r.status}: ${safeBody.slice(0, 120) || "(no body)"}`,
      };
    }
    const data = (await r.json().catch(() => null)) as
      | { ok?: boolean; result?: { username?: string; first_name?: string; id?: number } }
      | null;
    const me = data?.result;
    const label = me?.username
      ? `@${me.username}`
      : me?.first_name ?? `id ${me?.id ?? "?"}`;
    return {
      name: "telegram-bot",
      status: "ok",
      detail: `${label} → chat \`${chatId}\``,
    };
  } catch (err) {
    return {
      name: "telegram-bot",
      status: "warn",
      detail: `getMe failed: ${(err as Error).message || "(unknown)"} (creds present, network/Telegram issue)`,
    };
  } finally {
    clearTimeout(timer);
  }
}

function checkTelegramUserClient(): CheckResult {
  const { user } = getManifestTelegramSettings();
  const hasApiId = user.apiId > 0;
  const hasApiHash = user.apiHash.length > 0;
  const hasSession = user.session.length > 0;
  if (!hasApiId && !hasApiHash && !hasSession) {
    return {
      name: "telegram-user",
      status: "missing",
      detail: "not configured (run `npm run telegram:login` to enable MTProto)",
    };
  }
  if (!hasApiId || !hasApiHash || !hasSession) {
    const missing: string[] = [];
    if (!hasApiId) missing.push("apiId");
    if (!hasApiHash) missing.push("apiHash");
    if (!hasSession) missing.push("session");
    return {
      name: "telegram-user",
      status: "warn",
      detail: `partial creds — missing: ${missing.join(", ")}`,
    };
  }
  const target = user.targetChatId.trim() || "Saved Messages";
  return {
    name: "telegram-user",
    status: "configured",
    detail: `apiId=${user.apiId} → ${target}`,
  };
}

function checkAuth(): CheckResult {
  const cfg = loadAuthConfig();
  if (!cfg) {
    let setupToken = "";
    try {
      setupToken = ensureSetupToken();
    } catch (err) {
      logWarn("startup", "failed to mint setup token (non-fatal)", { error: (err as Error)?.message ?? String(err) });
    }
    const tokenHint = setupToken
      ? ` — paste setup token \`${setupToken}\` from this terminal into the form`
      : "";
    return {
      name: "auth",
      status: "missing",
      detail: `no operator account — open ${BRIDGE_URL}/login on this machine to set one${tokenHint}`,
    };
  }
  clearSetupToken();
  const live = pruneExpired(cfg.trustedDevices);
  return {
    name: "auth",
    status: "ok",
    detail: `operator=${cfg.email}, trusted devices=${live.length}`,
  };
}

function checkProcessLock(): CheckResult {
  const lock = acquireProcessLock({ port: BRIDGE_PORT, url: BRIDGE_URL });
  if (!lock.acquired && lock.heldBy) {
    const at = lock.heldBy.url ? ` (${lock.heldBy.url})` : "";
    return {
      name: "process-lock",
      status: "error",
      detail: `another bridge (pid ${lock.heldBy.pid}${at}) already owns this sessions dir — concurrent meta.json writes can drop runs; stop the duplicate`,
    };
  }
  return {
    name: "process-lock",
    status: "ok",
    detail: lock.tookOverStale
      ? `acquired (reclaimed stale lock from a crashed boot), pid ${process.pid}`
      : `acquired, pid ${process.pid}`,
  };
}

function checkApps(): CheckResult {
  const apps = loadApps();
  if (apps.length === 0) {
    return {
      name: "apps",
      status: "warn",
      detail: "no apps registered (use the UI's Add app / Auto-detect to populate)",
    };
  }
  const names = apps.map((a) => a.name).slice(0, 6).join(", ");
  const more = apps.length > 6 ? ` +${apps.length - 6} more` : "";
  return {
    name: "apps",
    status: "ok",
    detail: `${apps.length} registered: ${names}${more}`,
  };
}

const STATUS_GLYPH: Record<CheckStatus, string> = {
  ok: "✓",
  configured: "·",
  missing: "○",
  warn: "!",
  error: "✗",
};

export async function runStartupChecks(): Promise<CheckResult[]> {
  logInfo(
    "startup",
    `starting up — port=${BRIDGE_PORT} url=${BRIDGE_URL}`,
  );

  writeRuntimeMeta({ url: BRIDGE_URL, port: BRIDGE_PORT });

  const sync: CheckResult[] = [
    checkProcessLock(),
    checkAuth(),
    checkApps(),
    checkTelegramUserClient(),
  ];

  const asyncResults = await Promise.all([checkClaudeCli(), checkTelegramBot()]);

  const all: CheckResult[] = [
    sync[0],
    sync[1],
    asyncResults[0],
    sync[2],
    asyncResults[1],
    sync[3],
  ];

  for (const r of all) {
    const tag = `${STATUS_GLYPH[r.status]} ${r.name.padEnd(15, " ")} ${r.status.toUpperCase().padEnd(11, " ")} ${r.detail}`;
    if (r.status === "error") logError("startup", tag);
    else if (r.status === "warn") logWarn("startup", tag);
    else logInfo("startup", tag);
  }
  return all;
}
