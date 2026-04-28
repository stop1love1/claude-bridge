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
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
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
  shutdownInstalled: boolean;
}

const G = globalThis as unknown as { __bridgeTunnels?: Registry };
const reg: Registry = G.__bridgeTunnels ?? { tunnels: new Map(), shutdownInstalled: false };
G.__bridgeTunnels = reg;

const MAX_LOG_LINES = 50;
const MAX_CONCURRENT = 8;

/**
 * URL extraction patterns. Both providers print the public URL on
 * stdout shortly after start; we just regex the first match.
 *
 *   - localtunnel: `your url is: https://shaggy-radios-watch.loca.lt`
 *   - ngrok:       `... msg="started tunnel" ... url=https://abc.ngrok-free.app`
 */
const URL_RES: Record<TunnelProvider, RegExp> = {
  localtunnel: /https?:\/\/[a-z0-9-]+\.loca\.lt/i,
  ngrok: /https?:\/\/[a-z0-9-]+\.ngrok[a-z0-9.-]*\b/i,
};

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

/** Subdomains: 4-63 chars, ASCII-lowercase + digits + hyphen, no edge dashes. */
const SUBDOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{2,61}[a-z0-9])$/;

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
    if (!SUBDOMAIN_RE.test(s)) {
      throw new Error(
        "subdomain must be 4–63 chars, lowercase letters/digits/hyphens, no edge dashes",
      );
    }
    if (opts.provider !== "localtunnel") {
      throw new Error("custom subdomain is only supported for localtunnel");
    }
    subdomain = s;
  }

  const { command, args, env } = buildSpawnArgs(opts.provider, port, subdomain);

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

  // `shell: true` lets `bunx` / `where`-resolved binaries be found via
  // PATHEXT on Windows. For ngrok we resolve the absolute path up
  // front (so a winget install in the same session works without a
  // PATH refresh), then `shell: false` is fine — but keeping `shell:
  // true` uniform is harmless and one less branching surface.
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
    windowsHide: true,
    env,
  });

  reg.tunnels.set(id, { entry, child });
  installShutdownHandler();

  const matchUrl = URL_RES[opts.provider];
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    for (const line of chunk.split(/\r?\n/)) {
      if (!line) continue;
      pushLog(entry, line);
      const m = matchUrl.exec(line);
      if (m && !entry.url) {
        entry.url = m[0];
        entry.status = "running";
      }
    }
  });
  child.stderr?.on("data", (chunk: string) => {
    for (const line of chunk.split(/\r?\n/)) {
      if (!line) continue;
      pushLog(entry, `[stderr] ${line}`);
      // ngrok prints recoverable warnings to stderr too — only flip
      // to error if we never got a URL.
      const m = matchUrl.exec(line);
      if (m && !entry.url) {
        entry.url = m[0];
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
 */
function buildSpawnArgs(
  provider: TunnelProvider,
  port: number,
  subdomain: string | undefined,
): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  if (provider === "localtunnel") {
    const args = ["localtunnel", "--port", String(port)];
    if (subdomain) args.push("--subdomain", subdomain);
    return {
      command: "bunx",
      args,
      env: process.env,
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

function installShutdownHandler(): void {
  if (reg.shutdownInstalled) return;
  reg.shutdownInstalled = true;
  const onExit = () => { killAllTunnels(); };
  process.once("SIGINT", () => { onExit(); process.exit(130); });
  process.once("SIGTERM", () => { onExit(); process.exit(143); });
  process.once("exit", onExit);
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

export function detectProviders(): ProviderStatus[] {
  return [detectLocaltunnel(), detectNgrok()];
}

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
    return { ok: r.ok, status: detectNgrok(), log: r.log };
  }
  if (plan.kind === "brew") {
    const r = await runInstaller("brew", ["install", "ngrok/ngrok/ngrok"], 180_000);
    return { ok: r.ok, status: detectNgrok(), log: r.log };
  }
  return await installViaDownload(plan.url, plan.archive);
}

// -----------------------------------------------------------------------------
// ngrok authtoken — persisted in `bridge.json#tunnels.ngrok.authtoken`.
// File mode 0600 (matches the rest of bridge.json) so a colocated POSIX
// user can't read it.
// -----------------------------------------------------------------------------

const BRIDGE_JSON = join(USER_CLAUDE_DIR, "bridge.json");

interface TunnelManifest {
  ngrok?: { authtoken?: string };
}

interface RawManifest {
  version?: number;
  apps?: unknown;
  tunnels?: TunnelManifest;
  [k: string]: unknown;
}

function readTunnelManifest(): RawManifest {
  if (!existsSync(BRIDGE_JSON)) return { version: 1, apps: [] };
  try {
    return JSON.parse(readFileSync(BRIDGE_JSON, "utf8")) as RawManifest;
  } catch {
    return { version: 1, apps: [] };
  }
}

function writeTunnelManifest(m: RawManifest): void {
  const ordered = {
    version: typeof m.version === "number" ? m.version : 1,
    apps: Array.isArray(m.apps) ? m.apps : [],
    ...Object.fromEntries(Object.entries(m).filter(([k]) => k !== "version" && k !== "apps")),
  };
  mkdirSync(dirname(BRIDGE_JSON), { recursive: true });
  const tmp = `${BRIDGE_JSON}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(tmp, JSON.stringify(ordered, null, 2) + "\n", { mode: 0o600 });
  try {
    renameSync(tmp, BRIDGE_JSON);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
  try { chmodSync(BRIDGE_JSON, 0o600); } catch { /* ignore (windows) */ }
}

export function getNgrokAuthtoken(): string {
  const m = readTunnelManifest();
  const t = m.tunnels?.ngrok?.authtoken;
  return typeof t === "string" ? t.trim() : "";
}

/**
 * Persist (or clear with `""`) the ngrok authtoken. Tokens have a
 * stable shape — `\d+_[A-Za-z0-9]+` — so a paste from the dashboard
 * normalizes by stripping whitespace and that's about it.
 */
export function setNgrokAuthtoken(input: string): string {
  const trimmed = (input ?? "").trim();
  const m = readTunnelManifest();
  const tunnels: TunnelManifest = { ...(m.tunnels ?? {}) };
  if (trimmed) {
    tunnels.ngrok = { ...(tunnels.ngrok ?? {}), authtoken: trimmed };
  } else if (tunnels.ngrok) {
    delete tunnels.ngrok.authtoken;
    if (Object.keys(tunnels.ngrok).length === 0) delete tunnels.ngrok;
  }
  const next: RawManifest = { ...m };
  if (Object.keys(tunnels).length > 0) {
    next.tunnels = tunnels;
  } else {
    delete next.tunnels;
  }
  writeTunnelManifest(next);
  return trimmed;
}
