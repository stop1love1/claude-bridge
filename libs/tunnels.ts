/**
 * Dev-time public tunnel registry.
 *
 * Spawns a tunnel client for an operator-chosen port (localtunnel or
 * ngrok), parses the resulting public URL out of stdout, and tracks
 * the live ChildProcess so the UI can list / stop them. State is
 * in-memory only — `killAllTunnels()` runs on bridge shutdown so
 * nothing leaks past the parent process.
 *
 * Stashed on `globalThis` for the same reason as `spawnRegistry.ts` —
 * Next.js dev HMR otherwise drops the Map when this module is reloaded.
 *
 * Provider notes:
 *
 *   - **localtunnel**: invoked via `bunx localtunnel --port <p>`. Free,
 *     no signup, but slow + has an interstitial warning page on first
 *     visit per IP. URL: `*.loca.lt`.
 *   - **ngrok**: invoked via the operator's installed `ngrok` binary
 *     (Windows location auto-detected if not on PATH). Faster + no
 *     interstitial, but needs an authtoken from ngrok.com which we
 *     persist in `bridge.json#tunnels.ngrok.authtoken`. URL: typically
 *     `*.ngrok-free.app` on the free plan.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  onBridgeManifestWrite,
  readBridgeManifest,
  updateBridgeManifest,
} from "./bridgeManifest";
import { USER_CLAUDE_DIR } from "./paths";
import { treeKill } from "./processKill";

export type TunnelStatus = "starting" | "running" | "error" | "stopped";
export type TunnelProvider = "localtunnel" | "ngrok";

export interface TunnelEntry {
  id: string;
  port: number;
  label?: string;
  /** Operator-requested sticky subdomain (localtunnel only). */
  subdomain?: string;
  provider: TunnelProvider;
  status: TunnelStatus;
  url?: string;
  error?: string;
  startedAt: string;
  endedAt?: string;
  /** Last ~50 lines of combined stdout/stderr for debugging in the UI. */
  log: string[];
}

interface Registry {
  tunnels: Map<string, { entry: TunnelEntry; child: ChildProcess }>;
}

const G = globalThis as unknown as { __bridgeTunnels?: Registry };
const reg: Registry = G.__bridgeTunnels ?? { tunnels: new Map() };
G.__bridgeTunnels = reg;

const MAX_LOG_LINES = 50;
const MAX_CONCURRENT = 8;

/**
 * URL extraction patterns. Both providers print the public URL on
 * stdout shortly after start, but ngrok also writes its structured
 * log (success AND error) to stderr in non-TTY mode. A bare-URL match
 * would flip status="running" on lines like
 *   `lvl=eror msg="failed to start tunnel" url=https://...`
 * even though the tunnel never came up.
 *
 * Each pattern below is anchored on the success-context cue so an
 * error line that happens to contain the URL doesn't qualify:
 *   - localtunnel: `your url is: https://shaggy-radios-watch.loca.lt`
 *   - ngrok:       `... msg="started tunnel" ... url=https://abc.ngrok-free.app`
 *
 * The captured URL is in group 1 (the success cue is matched but
 * discarded). Bare-URL extraction for diagnostic logging stays in
 * `pushLog` — only the status flip is gated.
 */
const URL_RES: Record<TunnelProvider, RegExp> = {
  localtunnel: /your url is:\s+(https?:\/\/[a-z0-9-]+\.loca\.lt)/i,
  ngrok: /msg="?started tunnel"?[^\n]*?url=(https?:\/\/[a-z0-9-]+\.ngrok[a-z0-9.-]*)/i,
};

/**
 * Pure helper: extract the public URL from a single log line, but
 * ONLY when the line carries the provider-specific success cue. Use
 * this in tests to lock in the false-positive guard without spawning
 * a real provider process.
 */
export function extractTunnelUrl(
  provider: TunnelProvider,
  line: string,
): string | null {
  if (typeof line !== "string" || !line) return null;
  const m = URL_RES[provider]?.exec(line);
  return m && m[1] ? m[1] : null;
}

function pushLog(entry: TunnelEntry, line: string): void {
  const trimmed = line.replace(/\r?\n$/, "");
  if (!trimmed) return;
  entry.log.push(trimmed);
  if (entry.log.length > MAX_LOG_LINES) {
    entry.log.splice(0, entry.log.length - MAX_LOG_LINES);
  }
}

function genId(): string {
  return `tun_${randomBytes(6).toString("hex")}`;
}

function publicView(entry: TunnelEntry): TunnelEntry {
  return { ...entry, log: [...entry.log] };
}

export function listTunnels(): TunnelEntry[] {
  return Array.from(reg.tunnels.values())
    .map((t) => publicView(t.entry))
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

export function getTunnel(id: string): TunnelEntry | null {
  const slot = reg.tunnels.get(id);
  return slot ? publicView(slot.entry) : null;
}

export interface StartOptions {
  port: number;
  provider: TunnelProvider;
  label?: string;
  /**
   * Sticky subdomain. localtunnel honors `--subdomain <s>` and gives back
   * `https://<s>.loca.lt` (errors out if taken). ngrok free silently
   * ignores custom subdomains, so we only forward this when the
   * provider is localtunnel.
   */
  subdomain?: string;
}

/**
 * Subdomains: 4-63 chars, ASCII-lowercase + digits + hyphen, no edge dashes.
 *
 * Length is checked separately so a 4-char subdomain like `abcd` doesn't
 * trip a regex that requires the body to have ≥2 chars. The previous
 * pattern (`^[a-z0-9](?:[a-z0-9-]{2,61}[a-z0-9])$`) had a non-optional
 * inner group, so it rejected anything 4 chars or shorter — contradicting
 * the user-facing "4–63" message.
 */
const SUBDOMAIN_BODY_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export function isValidSubdomain(s: string): boolean {
  if (s.length < 4 || s.length > 63) return false;
  return SUBDOMAIN_BODY_RE.test(s);
}

export function startTunnel(opts: StartOptions): TunnelEntry {
  const port = Number(opts.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("port must be an integer 1-65535");
  }
  if (opts.provider !== "localtunnel" && opts.provider !== "ngrok") {
    throw new Error(`unknown provider: ${String(opts.provider)}`);
  }
  const live = Array.from(reg.tunnels.values()).filter(
    (t) => t.entry.status === "starting" || t.entry.status === "running",
  );
  if (live.length >= MAX_CONCURRENT) {
    throw new Error(`max ${MAX_CONCURRENT} concurrent tunnels reached — stop one first`);
  }
  if (live.some((t) => t.entry.port === port && t.entry.provider === opts.provider)) {
    throw new Error(`port ${port} already has a live ${opts.provider} tunnel`);
  }

  let subdomain: string | undefined;
  if (opts.subdomain && opts.subdomain.trim()) {
    const s = opts.subdomain.trim().toLowerCase();
    if (!isValidSubdomain(s)) {
      throw new Error(
        "subdomain must be 4–63 chars, lowercase letters/digits/hyphens, no edge dashes",
      );
    }
    if (opts.provider !== "localtunnel") {
      throw new Error("custom subdomain is only supported for localtunnel");
    }
    subdomain = s;
  }

  const { command, args, env, useShell } = buildSpawnArgs(opts.provider, port, subdomain);

  const id = genId();
  const entry: TunnelEntry = {
    id,
    port,
    provider: opts.provider,
    status: "starting",
    startedAt: new Date().toISOString(),
    log: [],
  };
  if (opts.label && opts.label.trim()) entry.label = opts.label.trim().slice(0, 80);
  if (subdomain) entry.subdomain = subdomain;

  // `shell: true` is required only for `bunx`, which on Windows lives
  // as a .cmd shim that Node's direct exec path can't run. For ngrok
  // we pass an absolute path resolved up front, so `shell: false`
  // works everywhere AND avoids quoting bugs when the path itself
  // contains spaces (e.g. `C:\Program Files\ngrok\ngrok.exe` once
  // ngrok ships an MSI installer there).
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    shell: useShell,
    windowsHide: true,
    env,
  });

  reg.tunnels.set(id, { entry, child });

  const matchUrl = URL_RES[opts.provider];
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    for (const line of chunk.split(/\r?\n/)) {
      if (!line) continue;
      pushLog(entry, line);
      const m = matchUrl.exec(line);
      if (m && m[1] && !entry.url) {
        entry.url = m[1];
        entry.status = "running";
      }
    }
  });
  child.stderr?.on("data", (chunk: string) => {
    for (const line of chunk.split(/\r?\n/)) {
      if (!line) continue;
      pushLog(entry, `[stderr] ${line}`);
      // ngrok writes its structured success log to stderr too — accept
      // matches only when the regex includes the success cue (group 1
      // is the URL). Pure error lines that mention the URL no longer
      // flip status="running".
      const m = matchUrl.exec(line);
      if (m && m[1] && !entry.url) {
        entry.url = m[1];
        entry.status = "running";
      }
    }
  });
  child.on("error", (err) => {
    entry.status = "error";
    entry.error = err.message || String(err);
    entry.endedAt = new Date().toISOString();
    pushLog(entry, `[error] ${entry.error}`);
  });
  child.on("exit", (code, signal) => {
    if (entry.status !== "stopped" && entry.status !== "error") {
      entry.status = code === 0 ? "stopped" : "error";
      if (code !== 0 && !entry.error) {
        entry.error = `${opts.provider} exited with code ${code}${signal ? ` (${signal})` : ""}`;
      }
    }
    entry.endedAt = new Date().toISOString();
    pushLog(entry, `[exit] code=${code ?? "null"} signal=${signal ?? "null"}`);
  });

  return publicView(entry);
}

/**
 * Resolve the per-provider command + args + env that `startTunnel`
 * passes to `spawn`. Kept separate so unit-testing the matrix doesn't
 * have to spin up real subprocesses.
 *
 * `useShell` is provider-specific: `bunx` is a Windows .cmd shim
 * (needs `shell: true` for cmd to find PATHEXT); `ngrok` is an
 * absolute path we resolved ourselves (so `shell: false` is safe AND
 * preferred — it survives spaces in the path without quoting tricks).
 */
function buildSpawnArgs(
  provider: TunnelProvider,
  port: number,
  subdomain: string | undefined,
): { command: string; args: string[]; env: NodeJS.ProcessEnv; useShell: boolean } {
  if (provider === "localtunnel") {
    const args = ["localtunnel", "--port", String(port)];
    if (subdomain) args.push("--subdomain", subdomain);
    return {
      command: "bunx",
      args,
      env: process.env,
      useShell: true,
    };
  }
  // ngrok: prefer absolute path so a fresh winget install is reachable
  // without restarting the bridge (winget shims live under
  // `%LocalAppData%\Microsoft\WinGet\Links` which the bridge process's
  // PATH snapshot may pre-date). Fall back to bare `ngrok` if we can't
  // resolve — the spawn will ENOENT and the UI surfaces the error.
  const resolved = findNgrokExecutable() ?? "ngrok";
  const token = getNgrokAuthtoken();
  if (!token) {
    throw new Error(
      "ngrok authtoken not set — open the Tunnels page and click 'Configure ngrok'",
    );
  }
  return {
    command: resolved,
    // `--log=stdout` routes ngrok's structured logs to stdout so we
    // can regex out the URL line. Default behavior is a TTY dashboard
    // that doesn't print the URL plainly.
    args: ["http", String(port), "--log=stdout"],
    env: { ...process.env, NGROK_AUTHTOKEN: token },
    // Absolute path resolved up-front — `shell: false` avoids
    // word-splitting spaces in `C:\Program Files\...`.
    useShell: resolved === "ngrok",
  };
}

export function stopTunnel(id: string): boolean {
  const slot = reg.tunnels.get(id);
  if (!slot) return false;
  if (slot.entry.status === "stopped" || slot.entry.status === "error") {
    return true;
  }
  treeKill(slot.child, "SIGTERM");
  slot.entry.status = "stopped";
  slot.entry.endedAt = new Date().toISOString();
  const t = setTimeout(() => {
    if (slot.child.exitCode === null && slot.child.signalCode === null) {
      treeKill(slot.child, "SIGKILL");
    }
  }, 3000);
  if (typeof t.unref === "function") t.unref();
  return true;
}

export function removeTunnel(id: string): boolean {
  const existed = reg.tunnels.has(id);
  reg.tunnels.delete(id);
  return existed;
}

/**
 * Kill every live tunnel synchronously enough for a Ctrl-C / shutdown
 * path. SIGTERM first; the OS reaps the child as the parent exits.
 * Idempotent — safe to call from multiple signal handlers.
 *
 * Registered eagerly from `instrumentation.ts` so the handler exists
 * before any tunnel is spawned. (Lazy `process.once(...)` from inside
 * `startTunnel` was a footgun: a SIGINT delivered before the first
 * tunnel was started would leave no handler in place, and HMR could
 * trap a stale closure on subsequent reloads.)
 */
export function killAllTunnels(): void {
  for (const slot of reg.tunnels.values()) {
    if (slot.entry.status === "starting" || slot.entry.status === "running") {
      treeKill(slot.child, "SIGTERM");
      slot.entry.status = "stopped";
      slot.entry.endedAt = new Date().toISOString();
    }
  }
}

// -----------------------------------------------------------------------------
// Provider detection — `GET /api/tunnels/providers` reads this to render the
// "ngrok needs install / needs authtoken / ready" status block.
// -----------------------------------------------------------------------------

export interface ProviderStatus {
  provider: TunnelProvider;
  /** Binary is installed and runnable (always true for localtunnel — bunx is bundled). */
  installed: boolean;
  /** Resolved version string when the binary responds to `--version` / `version`. */
  version?: string;
  /** True for ngrok when an authtoken is persisted in `bridge.json`. */
  authtokenSet?: boolean;
  /** True when this host can offer a one-click install (Windows + winget). */
  installable: boolean;
  /** Human-readable hint surfaced in the UI when the provider isn't ready. */
  hint?: string;
}

/**
 * Cache `detectProviders()` for a handful of seconds. The Tunnels page
 * polls `/api/tunnels/providers` every 1–4 seconds; without a cache
 * each poll spawned `where.exe ngrok` + `ngrok version` synchronously
 * (each up to 5s timeout), blocking the event loop. Cleared whenever
 * the ngrok authtoken changes (see `setNgrokAuthtoken`) so a UI save
 * is reflected on the next request.
 */
const PROVIDER_CACHE_TTL_MS = 5000;
let providerCache: { value: ProviderStatus[]; expires: number } | null = null;

export function detectProviders(): ProviderStatus[] {
  const now = Date.now();
  if (providerCache && providerCache.expires > now) return providerCache.value;
  const value = [detectLocaltunnel(), detectNgrok()];
  providerCache = { value, expires: now + PROVIDER_CACHE_TTL_MS };
  return value;
}

function invalidateProviderCache(): void {
  providerCache = null;
}

// Manifest writes from outside this module (auth.ts saving credentials,
// apps.ts editing settings) don't move the ngrok binary, so they
// don't need to bust the provider cache. We invalidate it on
// authtoken-write paths inline below — that's the only field that
// affects the `authtokenSet` boolean.

function detectLocaltunnel(): ProviderStatus {
  // localtunnel runs via `bunx`, which ships with Bun (the runtime
  // already required by package.json). We don't probe — the cost
  // (npm metadata fetch on first run) isn't worth surfacing per page
  // load.
  return {
    provider: "localtunnel",
    installed: true,
    installable: false,
  };
}

function detectNgrok(): ProviderStatus {
  const exe = findNgrokExecutable();
  if (!exe) {
    const plan = installerPlan();
    return {
      provider: "ngrok",
      installed: false,
      installable: plan.kind !== "manual",
      hint: plan.hint,
    };
  }
  const versionResult = spawnSync(exe, ["version"], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
  });
  const version =
    versionResult.status === 0
      ? (versionResult.stdout.trim().split(/\s+/).pop() ?? "")
      : undefined;
  const authtokenSet = !!getNgrokAuthtoken();
  return {
    provider: "ngrok",
    installed: true,
    version,
    authtokenSet,
    installable: false,
    hint: authtokenSet
      ? undefined
      : "Authtoken not set. Get one from https://dashboard.ngrok.com/get-started/your-authtoken and save it below.",
  };
}

/**
 * Best-effort ngrok binary lookup. Tries PATH first, then platform-
 * specific install locations so a fresh install in the same session
 * is usable immediately without restarting the bridge.
 *
 * Lookup order:
 *   1. `where.exe` / `which ngrok` — covers any user-installed binary.
 *   2. Windows: `%LocalAppData%\Microsoft\WinGet\Links\ngrok.exe`
 *      (winget shim) → `%ProgramFiles%\ngrok\ngrok.exe`.
 *   3. macOS: `/opt/homebrew/bin/ngrok` (Apple Silicon) →
 *      `/usr/local/bin/ngrok` (Intel) — the two brew prefixes.
 *   4. POSIX (mac/Linux): `~/.claude/bin/ngrok` — where our tarball
 *      installer extracts when no package manager is available.
 */
function findNgrokExecutable(): string | null {
  const probe =
    process.platform === "win32"
      ? spawnSync("where.exe", ["ngrok"], { encoding: "utf8", timeout: 3000, windowsHide: true })
      : spawnSync("which", ["ngrok"], { encoding: "utf8", timeout: 3000 });
  if (probe.status === 0 && probe.stdout) {
    const first = probe.stdout.split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0);
    if (first && existsSync(first)) return first;
  }
  const candidates: string[] = [];
  if (process.platform === "win32") {
    const local = process.env["LocalAppData"] ?? process.env["LOCALAPPDATA"];
    if (local) candidates.push(join(local, "Microsoft", "WinGet", "Links", "ngrok.exe"));
    const pf = process.env["ProgramFiles"];
    if (pf) candidates.push(join(pf, "ngrok", "ngrok.exe"));
  } else {
    if (process.platform === "darwin") {
      candidates.push("/opt/homebrew/bin/ngrok", "/usr/local/bin/ngrok");
    }
    candidates.push(join(USER_CLAUDE_DIR, "bin", "ngrok"));
  }
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

// -----------------------------------------------------------------------------
// One-click ngrok installer (cross-platform)
//
// Strategy per OS:
//   - Windows  → `winget install Ngrok.Ngrok`
//   - macOS    → `brew install ngrok/ngrok/ngrok` if brew is on PATH,
//                otherwise download the official zip and extract to
//                `~/.claude/bin/ngrok`.
//   - Linux    → download the official tarball, extract to
//                `~/.claude/bin/ngrok`, chmod +x.
//
// `installerPlan()` is the single source of truth for both `detectNgrok`'s
// status hint and `installNgrok`'s dispatch.
// -----------------------------------------------------------------------------

export interface InstallResult {
  ok: boolean;
  status: ProviderStatus;
  log: string;
}

type InstallerPlan =
  | { kind: "winget"; hint: string }
  | { kind: "brew"; hint: string }
  | { kind: "download"; url: string; archive: "zip" | "tgz"; hint: string }
  | { kind: "manual"; hint: string };

/** Map Node's `process.arch` to ngrok's release-asset suffix. */
function mapArch(a: string): "amd64" | "arm64" | "386" | "arm" | null {
  if (a === "x64") return "amd64";
  if (a === "arm64") return "arm64";
  if (a === "ia32") return "386";
  if (a === "arm") return "arm";
  return null;
}

function commandExists(name: string): boolean {
  const probe =
    process.platform === "win32"
      ? spawnSync("where.exe", [name], { encoding: "utf8", timeout: 3000, windowsHide: true })
      : spawnSync("which", [name], { encoding: "utf8", timeout: 3000 });
  return probe.status === 0;
}

function installerPlan(): InstallerPlan {
  if (process.platform === "win32") {
    if (commandExists("winget")) {
      return { kind: "winget", hint: "Click Install to fetch ngrok via winget." };
    }
    return {
      kind: "manual",
      hint: "winget not on PATH. Install ngrok manually from https://ngrok.com/download.",
    };
  }
  const arch = mapArch(process.arch);
  if (process.platform === "darwin") {
    if (commandExists("brew")) {
      return { kind: "brew", hint: "Click Install to run brew install ngrok/ngrok/ngrok." };
    }
    if (!arch) {
      return {
        kind: "manual",
        hint: `Unsupported arch ${process.arch}. Install ngrok manually.`,
      };
    }
    return {
      kind: "download",
      url: `https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-darwin-${arch}.zip`,
      archive: "zip",
      hint: "Click Install to download ngrok and extract to ~/.claude/bin.",
    };
  }
  if (process.platform === "linux") {
    if (!arch) {
      return {
        kind: "manual",
        hint: `Unsupported arch ${process.arch}. Install ngrok manually.`,
      };
    }
    return {
      kind: "download",
      url: `https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-${arch}.tgz`,
      archive: "tgz",
      hint: "Click Install to download ngrok and extract to ~/.claude/bin.",
    };
  }
  return {
    kind: "manual",
    hint: "Unsupported platform. Install ngrok manually from https://ngrok.com/download.",
  };
}

/**
 * Run a long-running install command and resolve with the combined
 * stdout/stderr log. Caps at `timeoutMs` so a stalled download doesn't
 * tie up the API request indefinitely. Never throws — failure surfaces
 * via `ok: false` so the route can render the log.
 */
function runInstaller(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; log: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
      windowsHide: true,
    });
    let log = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (s: string) => { log += s; });
    child.stderr?.on("data", (s: string) => { log += s; });
    const t = setTimeout(() => {
      treeKill(child, "SIGKILL");
      log += `\n[bridge] ${command} timed out after ${Math.round(timeoutMs / 1000)}s`;
    }, timeoutMs);
    if (typeof t.unref === "function") t.unref();
    child.on("error", (err) => {
      clearTimeout(t);
      resolve({ ok: false, log: `${log}\n[bridge] failed to spawn ${command}: ${err.message}` });
    });
    child.on("exit", (code) => {
      clearTimeout(t);
      resolve({ ok: code === 0, log: log.trim() });
    });
  });
}

async function installViaDownload(url: string, archive: "zip" | "tgz"): Promise<InstallResult> {
  // curl ships by default on macOS, modern Linux distros, and Windows
  // 10+ (1803). For minimal containers / older Windows we surface a
  // clear hint instead of letting `runInstaller` fail with a vague
  // ENOENT — operators on those hosts should fall back to manual
  // download from ngrok.com.
  if (!commandExists("curl")) {
    return {
      ok: false,
      status: detectNgrok(),
      log:
        "[bridge] `curl` not found on PATH. Install curl, or download ngrok manually from https://ngrok.com/download.",
    };
  }

  const dir = join(USER_CLAUDE_DIR, "bin");
  mkdirSync(dir, { recursive: true });
  const archivePath = join(dir, archive === "zip" ? "ngrok-download.zip" : "ngrok-download.tgz");
  let combinedLog = `[bridge] downloading ${url}\n`;

  const dl = await runInstaller("curl", ["-fSL", url, "-o", archivePath], 120_000);
  combinedLog += dl.log;
  if (!dl.ok) {
    return { ok: false, status: detectNgrok(), log: combinedLog };
  }

  combinedLog += `\n[bridge] extracting ${archive} to ${dir}\n`;
  const extract =
    archive === "zip"
      ? await runInstaller("unzip", ["-o", archivePath, "-d", dir], 60_000)
      : await runInstaller("tar", ["-xzf", archivePath, "-C", dir], 60_000);
  combinedLog += extract.log;
  if (!extract.ok) {
    return { ok: false, status: detectNgrok(), log: combinedLog };
  }

  if (process.platform !== "win32") {
    spawnSync("chmod", ["+x", join(dir, "ngrok")]);
  }
  try { unlinkSync(archivePath); } catch { /* ignore — best-effort cleanup */ }

  invalidateProviderCache();
  const status = detectNgrok();
  combinedLog += `\n[bridge] installed to ${join(dir, "ngrok")}`;
  return { ok: status.installed, status, log: combinedLog };
}

/**
 * Install ngrok using whichever channel `installerPlan()` selects for
 * the current OS. Always returns — failures resolve `ok: false` with
 * a log payload so the UI can show what went wrong.
 */
export async function installNgrok(): Promise<InstallResult> {
  const plan = installerPlan();
  if (plan.kind === "manual") {
    return { ok: false, status: detectNgrok(), log: plan.hint };
  }
  if (plan.kind === "winget") {
    const r = await runInstaller(
      "winget",
      [
        "install",
        "--id",
        "Ngrok.Ngrok",
        "-e",
        "--accept-source-agreements",
        "--accept-package-agreements",
        "--silent",
      ],
      120_000,
    );
    invalidateProviderCache();
    return { ok: r.ok, status: detectNgrok(), log: r.log };
  }
  if (plan.kind === "brew") {
    const r = await runInstaller("brew", ["install", "ngrok/ngrok/ngrok"], 180_000);
    invalidateProviderCache();
    return { ok: r.ok, status: detectNgrok(), log: r.log };
  }
  return await installViaDownload(plan.url, plan.archive);
}

// -----------------------------------------------------------------------------
// ngrok authtoken — persisted in `bridge.json#tunnels.ngrok.authtoken`
// via the shared bridgeManifest helper. Single source of truth for IO
// avoids the historical race where this module had its own atomic-write
// path that didn't invalidate auth.ts's authCache (and vice versa).
// -----------------------------------------------------------------------------

interface TunnelManifestSection {
  ngrok?: { authtoken?: string };
}

// Drop the cached provider snapshot whenever bridge.json is rewritten
// from anywhere — most writes don't move the binary, but a save from
// `setNgrokAuthtoken()` flips `authtokenSet` and a quick subsequent
// detectProviders() must reflect that.
onBridgeManifestWrite(invalidateProviderCache);

export function getNgrokAuthtoken(): string {
  const m = readBridgeManifest();
  const tunnels = m.tunnels as TunnelManifestSection | undefined;
  const t = tunnels?.ngrok?.authtoken;
  return typeof t === "string" ? t.trim() : "";
}

/**
 * Persist (or clear with `""`) the ngrok authtoken. Tokens have a
 * stable shape — `\d+_[A-Za-z0-9]+` — so a paste from the dashboard
 * normalizes by stripping whitespace and that's about it.
 */
export function setNgrokAuthtoken(input: string): string {
  const trimmed = (input ?? "").trim();
  updateBridgeManifest((m) => {
    const tunnels: TunnelManifestSection = { ...((m.tunnels as TunnelManifestSection | undefined) ?? {}) };
    if (trimmed) {
      tunnels.ngrok = { ...(tunnels.ngrok ?? {}), authtoken: trimmed };
    } else if (tunnels.ngrok) {
      delete tunnels.ngrok.authtoken;
      if (Object.keys(tunnels.ngrok).length === 0) delete tunnels.ngrok;
    }
    const next = { ...m };
    if (Object.keys(tunnels).length > 0) {
      next.tunnels = tunnels;
    } else {
      delete next.tunnels;
    }
    return next;
  });
  return trimmed;
}
