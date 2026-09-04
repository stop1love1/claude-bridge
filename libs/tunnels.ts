import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  onBridgeManifestWrite,
  readBridgeManifest,
  updateBridgeManifest,
} from "./bridgeManifest";
import { getManifestPublicUrl, getTunnelAutoStart, setManifestPublicUrl } from "./apps";
import { BRIDGE_PORT, USER_CLAUDE_DIR } from "./paths";
import { treeKill } from "./processKill";
import {
  TUNNEL_PROVIDERS,
  isTunnelProvider,
  type TunnelProvider,
} from "./tunnelProvider";
import { logWarn } from "./log";

export type TunnelStatus = "starting" | "running" | "error" | "stopped";

export { TUNNEL_PROVIDERS, isTunnelProvider, type TunnelProvider };

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

interface Registry {
  tunnels: Map<string, { entry: TunnelEntry; child: ChildProcess }>;
}

const G = globalThis as unknown as { __bridgeTunnels?: Registry };
const reg: Registry = G.__bridgeTunnels ?? { tunnels: new Map() };
G.__bridgeTunnels = reg;

const MAX_LOG_LINES = 50;
const MAX_CONCURRENT = 8;
const MAX_HISTORY_ENTRIES = 20;

function pruneTunnelHistory(): void {
  const stopped: Array<[string, { entry: TunnelEntry; child: ChildProcess }]> = [];
  for (const [id, slot] of reg.tunnels) {
    if (slot.entry.status === "stopped" || slot.entry.status === "error") {
      stopped.push([id, slot]);
    }
  }
  if (stopped.length <= MAX_HISTORY_ENTRIES) return;
  stopped.sort(([, a], [, b]) => {
    const ae = a.entry.endedAt ?? a.entry.startedAt;
    const be = b.entry.endedAt ?? b.entry.startedAt;
    return ae.localeCompare(be);
  });
  const toEvict = stopped.length - MAX_HISTORY_ENTRIES;
  for (let i = 0; i < toEvict; i++) {
    reg.tunnels.delete(stopped[i][0]);
  }
}

const URL_RES: Record<TunnelProvider, RegExp> = {
  localtunnel: /your url is:\s+(https?:\/\/[a-z0-9-]+\.loca\.lt)/i,
  ngrok: /msg="?started tunnel"?[^\n]*?url=(https?:\/\/[a-z0-9-]+\.ngrok[a-z0-9.-]*)/i,
  // cloudflared prints the URL alone inside an ASCII box on stderr. Anchored on
  // `.trycloudflare.com` rather than `cloudflare.com`, because the account-less
  // warning banner it prints first links www.cloudflare.com and developers.cloudflare.com.
  cloudflared: /(https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com)/i,
};

export function extractTunnelUrl(
  provider: TunnelProvider,
  line: string,
): string | null {
  if (typeof line !== "string" || !line) return null;
  const m = URL_RES[provider]?.exec(line);
  return m && m[1] ? m[1] : null;
}

function resolveBridgePort(): number {
  return BRIDGE_PORT;
}

function onTunnelRunning(entry: TunnelEntry): void {
  if (!entry.url || entry.port !== resolveBridgePort()) return;
  try {
    setManifestPublicUrl(entry.url);
  } catch (err) {
    logWarn("tunnels", "failed to write publicUrl", { error: (err as Error).message });
  }
}

function onTunnelStopped(entry: TunnelEntry): void {
  if (!entry.url) return;
  try {
    if (getManifestPublicUrl() === entry.url) {
      setManifestPublicUrl("");
    }
  } catch (err) {
    logWarn("tunnels", "failed to clear publicUrl", { error: (err as Error).message });
  }
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
  subdomain?: string;
}

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
  if (!isTunnelProvider(opts.provider)) {
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
        onTunnelRunning(entry);
      }
    }
  });
  child.stderr?.on("data", (chunk: string) => {
    for (const line of chunk.split(/\r?\n/)) {
      if (!line) continue;
      pushLog(entry, `[stderr] ${line}`);
      const m = matchUrl.exec(line);
      if (m && m[1] && !entry.url) {
        entry.url = m[1];
        entry.status = "running";
        onTunnelRunning(entry);
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
    onTunnelStopped(entry);
    pruneTunnelHistory();
  });

  return publicView(entry);
}

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
  if (provider === "cloudflared") {
    const resolved = findProviderExecutable("cloudflared") ?? "cloudflared";
    return {
      command: resolved,
      args: [
        "tunnel",
        "--url",
        `http://localhost:${port}`,
        "--no-autoupdate",
      ],
      env: process.env,
      useShell: resolved === "cloudflared",
    };
  }
  const resolved = findProviderExecutable("ngrok") ?? "ngrok";
  const token = getNgrokAuthtoken();
  if (!token) {
    throw new Error(
      "ngrok authtoken not set — open the Tunnels page and click 'Configure ngrok'",
    );
  }
  return {
    command: resolved,
    args: ["http", String(port), "--log=stdout"],
    env: { ...process.env, NGROK_AUTHTOKEN: token },
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
  onTunnelStopped(slot.entry);
  const t = setTimeout(() => {
    if (slot.child.exitCode === null && slot.child.signalCode === null) {
      treeKill(slot.child, "SIGKILL");
    }
  }, 3000);
  if (typeof t.unref === "function") t.unref();
  return true;
}

export function removeTunnel(id: string): boolean {
  const slot = reg.tunnels.get(id);
  if (!slot) return false;
  onTunnelStopped(slot.entry);
  reg.tunnels.delete(id);
  return true;
}

export function killAllTunnels(): void {
  for (const slot of reg.tunnels.values()) {
    if (slot.entry.status === "starting" || slot.entry.status === "running") {
      treeKill(slot.child, "SIGTERM");
      slot.entry.status = "stopped";
      slot.entry.endedAt = new Date().toISOString();
      onTunnelStopped(slot.entry);
    }
  }
}

export async function maybeAutoStartTunnel(): Promise<void> {
  let cfg: ReturnType<typeof getTunnelAutoStart>;
  try {
    cfg = getTunnelAutoStart();
  } catch (err) {
    logWarn("tunnels", "auto-start failed", { error: (err as Error).message });
    return;
  }
  if (!cfg || !cfg.enabled) return;
  try {
    startTunnel({ port: cfg.port, provider: cfg.provider });
  } catch (err) {
    logWarn("tunnels", "auto-start failed", { error: (err as Error).message });
  }
}


export interface ProviderStatus {
  provider: TunnelProvider;
  installed: boolean;
  version?: string;
  authtokenSet?: boolean;
  installable: boolean;
  hint?: string;
}

const PROVIDER_CACHE_TTL_MS = 5000;
let providerCache: { value: ProviderStatus[]; expires: number } | null = null;

export function detectProviders(): ProviderStatus[] {
  const now = Date.now();
  if (providerCache && providerCache.expires > now) return providerCache.value;
  const value = [detectLocaltunnel(), detectNgrok(), detectCloudflared()];
  providerCache = { value, expires: now + PROVIDER_CACHE_TTL_MS };
  return value;
}

function invalidateProviderCache(): void {
  providerCache = null;
}


function detectLocaltunnel(): ProviderStatus {
  return {
    provider: "localtunnel",
    installed: true,
    installable: false,
  };
}

function detectNgrok(): ProviderStatus {
  const exe = findProviderExecutable("ngrok");
  if (!exe) {
    const plan = installerPlan("ngrok");
    return {
      provider: "ngrok",
      installed: false,
      installable: plan.kind !== "manual",
      hint: plan.hint,
    };
  }
  const authtokenSet = !!getNgrokAuthtoken();
  return {
    provider: "ngrok",
    installed: true,
    version: probeVersion(exe, ["version"]),
    authtokenSet,
    installable: false,
    hint: authtokenSet
      ? undefined
      : "Authtoken not set. Get one from https://dashboard.ngrok.com/get-started/your-authtoken and save it below.",
  };
}

function detectCloudflared(): ProviderStatus {
  const exe = findProviderExecutable("cloudflared");
  if (!exe) {
    const plan = installerPlan("cloudflared");
    return {
      provider: "cloudflared",
      installed: false,
      installable: plan.kind !== "manual",
      hint: plan.hint,
    };
  }
  return {
    provider: "cloudflared",
    installed: true,
    version: probeVersion(exe, ["--version"]),
    installable: false,
  };
}

function probeVersion(exe: string, args: string[]): string | undefined {
  const r = spawnSync(exe, args, { encoding: "utf8", timeout: 5000, windowsHide: true });
  if (r.status !== 0 || !r.stdout) return undefined;
  const firstLine = r.stdout.trim().split(/\r?\n/)[0] ?? "";
  // ngrok prints a bare "3.30.0"; cloudflared prints
  // "cloudflared version 2025.7.0 (built ...)" — take the first semver-ish token.
  const semver = /\b\d+\.\d+(?:\.\d+)?\b/.exec(firstLine);
  return semver ? semver[0] : (firstLine.split(/\s+/).pop() ?? undefined);
}

function findProviderExecutable(provider: InstallableProvider): string | null {
  const bin = provider;
  const probe =
    process.platform === "win32"
      ? spawnSync("where.exe", [bin], { encoding: "utf8", timeout: 3000, windowsHide: true })
      : spawnSync("which", [bin], { encoding: "utf8", timeout: 3000 });
  if (probe.status === 0 && probe.stdout) {
    const first = probe.stdout.split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0);
    if (first && existsSync(first)) return first;
  }
  for (const c of executableCandidates(provider)) {
    if (existsSync(c)) return c;
  }
  return null;
}

function executableCandidates(provider: InstallableProvider): string[] {
  const bin = provider;
  const candidates: string[] = [];
  if (process.platform === "win32") {
    const local = process.env["LocalAppData"] ?? process.env["LOCALAPPDATA"];
    if (local) candidates.push(join(local, "Microsoft", "WinGet", "Links", `${bin}.exe`));
    const pf = process.env["ProgramFiles"];
    if (pf) candidates.push(join(pf, bin, `${bin}.exe`));
    // cloudflared's own MSI lands in the x86 tree even on 64-bit Windows.
    const pf86 = process.env["ProgramFiles(x86)"];
    if (pf86) candidates.push(join(pf86, bin, `${bin}.exe`));
    return candidates;
  }
  if (process.platform === "darwin") {
    candidates.push(`/opt/homebrew/bin/${bin}`, `/usr/local/bin/${bin}`);
  }
  candidates.push(join(USER_CLAUDE_DIR, "bin", bin));
  return candidates;
}


export interface InstallResult {
  ok: boolean;
  status: ProviderStatus;
  log: string;
}

/** Providers that ship a binary the bridge can fetch. localtunnel runs via bunx. */
export type InstallableProvider = "ngrok" | "cloudflared";

export type InstallerPlan =
  | { kind: "winget"; packageId: string; hint: string }
  | { kind: "brew"; formula: string; hint: string }
  | { kind: "download"; url: string; archive: "zip" | "tgz" | "binary"; hint: string }
  | { kind: "manual"; hint: string };

interface ProviderInstallSpec {
  wingetId: string;
  brewFormula: string;
  downloadUrl: (platform: "darwin" | "linux", arch: string) => string | null;
  /** darwin ships a tarball, linux a bare binary — cloudflared differs from ngrok here. */
  archiveFor: (platform: "darwin" | "linux") => "zip" | "tgz" | "binary";
  manualUrl: string;
}

const INSTALL_SPECS: Record<InstallableProvider, ProviderInstallSpec> = {
  ngrok: {
    wingetId: "Ngrok.Ngrok",
    brewFormula: "ngrok/ngrok/ngrok",
    downloadUrl: (platform, arch) =>
      `https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-${platform}-${arch}.${platform === "darwin" ? "zip" : "tgz"}`,
    archiveFor: (platform) => (platform === "darwin" ? "zip" : "tgz"),
    manualUrl: "https://ngrok.com/download",
  },
  cloudflared: {
    wingetId: "Cloudflare.cloudflared",
    brewFormula: "cloudflared",
    downloadUrl: (platform, arch) =>
      `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-${platform}-${arch}${platform === "darwin" ? ".tgz" : ""}`,
    archiveFor: (platform) => (platform === "darwin" ? "tgz" : "binary"),
    manualUrl: "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/",
  },
};

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

export function installerPlan(provider: InstallableProvider): InstallerPlan {
  const spec = INSTALL_SPECS[provider];
  if (process.platform === "win32") {
    if (commandExists("winget")) {
      return {
        kind: "winget",
        packageId: spec.wingetId,
        hint: `Click Install to fetch ${provider} via winget.`,
      };
    }
    return {
      kind: "manual",
      hint: `winget not on PATH. Install ${provider} manually from ${spec.manualUrl}.`,
    };
  }
  if (process.platform !== "darwin" && process.platform !== "linux") {
    return {
      kind: "manual",
      hint: `Unsupported platform. Install ${provider} manually from ${spec.manualUrl}.`,
    };
  }
  const platform = process.platform;
  if (platform === "darwin" && commandExists("brew")) {
    return {
      kind: "brew",
      formula: spec.brewFormula,
      hint: `Click Install to run brew install ${spec.brewFormula}.`,
    };
  }
  const arch = mapArch(process.arch);
  const url = arch ? spec.downloadUrl(platform, arch) : null;
  if (!url) {
    return {
      kind: "manual",
      hint: `Unsupported arch ${process.arch}. Install ${provider} manually from ${spec.manualUrl}.`,
    };
  }
  return {
    kind: "download",
    url,
    archive: spec.archiveFor(platform),
    hint: `Click Install to download ${provider} into ~/.claude/bin.`,
  };
}

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

function detectInstallable(provider: InstallableProvider): ProviderStatus {
  return provider === "ngrok" ? detectNgrok() : detectCloudflared();
}

async function installViaDownload(
  provider: InstallableProvider,
  url: string,
  archive: "zip" | "tgz" | "binary",
): Promise<InstallResult> {
  if (!commandExists("curl")) {
    return {
      ok: false,
      status: detectInstallable(provider),
      log:
        `[bridge] \`curl\` not found on PATH. Install curl, or download ${provider} manually from ${INSTALL_SPECS[provider].manualUrl}.`,
    };
  }

  const dir = join(USER_CLAUDE_DIR, "bin");
  mkdirSync(dir, { recursive: true });
  const binPath = join(dir, provider);
  // A bare binary downloads straight to its final name; an archive lands next to it.
  const downloadPath =
    archive === "binary" ? binPath : join(dir, `${provider}-download.${archive}`);
  let combinedLog = `[bridge] downloading ${url}\n`;

  const dl = await runInstaller("curl", ["-fSL", url, "-o", downloadPath], 120_000);
  combinedLog += dl.log;
  if (!dl.ok) {
    return { ok: false, status: detectInstallable(provider), log: combinedLog };
  }

  if (archive !== "binary") {
    combinedLog += `\n[bridge] extracting ${archive} to ${dir}\n`;
    const extract =
      archive === "zip"
        ? await runInstaller("unzip", ["-o", downloadPath, "-d", dir], 60_000)
        : await runInstaller("tar", ["-xzf", downloadPath, "-C", dir], 60_000);
    combinedLog += extract.log;
    if (!extract.ok) {
      return { ok: false, status: detectInstallable(provider), log: combinedLog };
    }
    try { unlinkSync(downloadPath); } catch { }
  }

  if (process.platform !== "win32") {
    spawnSync("chmod", ["+x", binPath]);
  }

  invalidateProviderCache();
  const status = detectInstallable(provider);
  combinedLog += `\n[bridge] installed to ${binPath}`;
  return { ok: status.installed, status, log: combinedLog };
}

export async function installProvider(
  provider: InstallableProvider,
): Promise<InstallResult> {
  const plan = installerPlan(provider);
  if (plan.kind === "manual") {
    return { ok: false, status: detectInstallable(provider), log: plan.hint };
  }
  if (plan.kind === "winget") {
    const r = await runInstaller(
      "winget",
      [
        "install",
        "--id",
        plan.packageId,
        "-e",
        "--accept-source-agreements",
        "--accept-package-agreements",
        "--silent",
      ],
      120_000,
    );
    invalidateProviderCache();
    return { ok: r.ok, status: detectInstallable(provider), log: r.log };
  }
  if (plan.kind === "brew") {
    const r = await runInstaller("brew", ["install", plan.formula], 180_000);
    invalidateProviderCache();
    return { ok: r.ok, status: detectInstallable(provider), log: r.log };
  }
  return await installViaDownload(provider, plan.url, plan.archive);
}

export function isInstallableProvider(v: unknown): v is InstallableProvider {
  return v === "ngrok" || v === "cloudflared";
}


interface TunnelManifestSection {
  ngrok?: { authtoken?: string };
}

onBridgeManifestWrite(invalidateProviderCache);

export function getNgrokAuthtoken(): string {
  const m = readBridgeManifest();
  const tunnels = m.tunnels as TunnelManifestSection | undefined;
  const t = tunnels?.ngrok?.authtoken;
  return typeof t === "string" ? t.trim() : "";
}

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
