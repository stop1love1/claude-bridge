/**
 * Startup banner — runs once per server boot from `instrumentation.ts`
 * and prints a `[bridge]` log block summarizing the health of every
 * service the bridge depends on (or speaks to). The goal is one
 * scannable view in the dev terminal so the operator immediately
 * knows whether Claude is reachable, whether Telegram credentials
 * actually work, etc., instead of finding out 10 minutes later when
 * a notification silently drops.
 *
 * Every check is best-effort: a network ping that times out just
 * downgrades the status from "ok" to "warn", it never throws and
 * never blocks the dev server from coming up. We deliberately keep
 * this module dependency-light — `node:child_process` for `claude
 * --version`, `fetch` for Telegram `/getMe`, no fancy logger.
 */

import { spawn } from "node:child_process";
import { loadAuthConfig, pruneExpired, writeRuntimeMeta } from "./auth";
import {
  getManifestTelegramSettings,
  loadApps,
} from "./apps";
import { BRIDGE_PORT, BRIDGE_URL } from "./paths";
import { clearSetupToken, ensureSetupToken } from "./setupToken";

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

/**
 * Spawn `claude --version` and resolve to the trimmed stdout, or null
 * when the binary can't be found / hangs / errors. We don't need the
 * exit code — any output that includes a recognizable version string
 * is enough to confirm the binary works.
 */
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
      try { child?.kill("SIGKILL"); } catch { /* ignore */ }
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
      // First non-empty line — `claude --version` prints something like
      // `1.2.3 (Claude Code)`; we grab the leading line so the banner
      // stays compact.
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
  // Best-effort `/getMe` ping with a short timeout. Don't block boot
  // if Telegram is slow / firewalled.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TG_TIMEOUT_MS);
  try {
    const r = await fetch(`${TG_HOST}/bot${botToken}/getMe`, {
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      return {
        name: "telegram-bot",
        status: "error",
        detail: `getMe HTTP ${r.status}: ${body.slice(0, 120) || "(no body)"}`,
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
      detail: "not configured (run `bun scripts/telegram-login.ts` to enable MTProto)",
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
  // Probing `client.connect()` here would gate the dev server on a
  // network round-trip; we only verify creds are present. The
  // `telegramNotifier`'s install path will warn separately if the
  // session has been revoked.
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
    // Mint a one-time setup token and surface it in the banner so the
    // operator can paste it into the first-run setup form. Without
    // the token, the setup endpoint refuses — that's what closes the
    // Host-header spoofing hole the previous loopback-only check
    // could not.
    let setupToken = "";
    try {
      setupToken = ensureSetupToken();
    } catch (err) {
      console.warn("[bridge] failed to mint setup token (non-fatal):", err);
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
  // Auth already configured — make sure no stale setup token file
  // lingers from a previous incomplete setup attempt. Cheap idempotent
  // unlink; password rotation must use the CLI from here on.
  clearSetupToken();
  const live = pruneExpired(cfg.trustedDevices);
  return {
    name: "auth",
    status: "ok",
    detail: `operator=${cfg.email}, trusted devices=${live.length}`,
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

/**
 * Run every startup check and emit a tagged log line per service. We
 * use console.info so it shows up in dev (`bun dev`) and `next start`
 * without needing a logger config — eslint's `no-console` is disabled
 * locally for this single banner. Returning the results lets tests
 * assert on the structure without scraping stdout.
 */
export async function runStartupChecks(): Promise<CheckResult[]> {
  console.info(
    `[bridge] starting up — port=${BRIDGE_PORT} url=${BRIDGE_URL}`,
  );

  // Drop the live URL into bridge.json#runtime so CLI helpers (the
  // `bun run approve:login` flow in particular) can locate the running
  // server without the operator having to know whether dev or prod is
  // up, or what port either bound to.
  writeRuntimeMeta({ url: BRIDGE_URL, port: BRIDGE_PORT });

  // Synchronous checks first (instant), async ones in parallel after.
  const sync: CheckResult[] = [checkAuth(), checkApps(), checkTelegramUserClient()];

  const asyncResults = await Promise.all([checkClaudeCli(), checkTelegramBot()]);

  const all: CheckResult[] = [
    sync[0],            // auth
    asyncResults[0],    // claude-cli
    sync[1],            // apps
    asyncResults[1],    // telegram-bot
    sync[2],            // telegram-user
  ];

  for (const r of all) {
    const tag = `[bridge] ${STATUS_GLYPH[r.status]} ${r.name.padEnd(15, " ")} ${r.status.toUpperCase().padEnd(11, " ")} ${r.detail}`;
    if (r.status === "error") console.error(tag);
    else if (r.status === "warn") console.warn(tag);
    else console.info(tag);
  }
  return all;
}
