import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { applyManyRuns, readMeta, type Meta, type Run } from "./meta";
import { getChild } from "./spawnRegistry";
import { getLastHeartbeat } from "./heartbeat";
import { BRIDGE_FOLDER, BRIDGE_ROOT, SESSIONS_DIR, readBridgeMd } from "./paths";
import { resolveRepoCwd } from "./repos";
import { projectDirFor } from "./sessions";

const execFileP = promisify(execFile);


const DEFAULT_QUEUED_STALE_MIN = 2;
const DEFAULT_STALE_RUN_MIN = 240;

function queuedStaleThresholdMs(): number {
  const raw = process.env.BRIDGE_QUEUED_STALE_MIN;
  const n = raw ? Number(raw) : DEFAULT_QUEUED_STALE_MIN;
  return (Number.isFinite(n) && n > 0 ? n : DEFAULT_QUEUED_STALE_MIN) * 60_000;
}

function jsonlStaleThresholdMs(): number {
  const raw = process.env.BRIDGE_STALE_RUN_MIN;
  const n = raw ? Number(raw) : DEFAULT_STALE_RUN_MIN;
  return (Number.isFinite(n) && n > 0 ? n : DEFAULT_STALE_RUN_MIN) * 60_000;
}

const ALIVE_PROBE_CACHE_MS = 5 * 60_000;
const ALIVE_PROBE_TIMEOUT_MS = 5_000;
let aliveSidsCache: { ids: Set<string>; expiresAt: number } | null = null;

const SESSION_ID_RE = /--session-id[\s=\0]+([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/g;

function probeAliveOnLinux(): Set<string> {
  const sids = new Set<string>();
  try {
    const entries = readdirSync("/proc");
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf8");
        if (!cmdline.includes("--session-id")) continue;
        let m: RegExpExecArray | null;
        SESSION_ID_RE.lastIndex = 0;
        while ((m = SESSION_ID_RE.exec(cmdline)) !== null) {
          sids.add(m[1].toLowerCase());
        }
      } catch {
      }
    }
  } catch {
  }
  return sids;
}

async function probeAliveClaudeSessions(): Promise<Set<string>> {
  if (process.platform === "linux") {
    return probeAliveOnLinux();
  }
  const sids = new Set<string>();
  try {
    let cmdOutput = "";
    if (process.platform === "win32") {
      const { stdout } = await execFileP(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "(Get-CimInstance Win32_Process).CommandLine",
        ],
        { timeout: ALIVE_PROBE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      );
      cmdOutput = stdout;
    } else {
      const { stdout } = await execFileP("ps", ["-eo", "args"], {
        timeout: ALIVE_PROBE_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
      });
      cmdOutput = stdout;
    }
    let m: RegExpExecArray | null;
    SESSION_ID_RE.lastIndex = 0;
    while ((m = SESSION_ID_RE.exec(cmdOutput)) !== null) {
      sids.add(m[1].toLowerCase());
    }
  } catch {
  }
  return sids;
}

async function getAliveClaudeSessions(): Promise<Set<string>> {
  if (process.env.VITEST) return new Set();
  const now = Date.now();
  if (aliveSidsCache && aliveSidsCache.expiresAt > now) {
    return aliveSidsCache.ids;
  }
  const ids = await probeAliveClaudeSessions();
  aliveSidsCache = { ids, expiresAt: now + ALIVE_PROBE_CACHE_MS };
  return ids;
}

export async function reapStaleRunsForDir(sessionsDir: string): Promise<Meta | null> {
  await bootSweepIfNeeded();
  const meta = readMeta(sessionsDir);
  if (!meta) return null;
  const patches = await computeStalePatches(meta);
  if (patches.length === 0) return meta;
  return (await applyManyRuns(sessionsDir, patches)) ?? meta;
}

type BridgeMdCache = { md: ReturnType<typeof readBridgeMd> | null; loaded: boolean };

function resolveRunCwd(run: Run, cache: BridgeMdCache): string | null {
  if (run.repo === BRIDGE_FOLDER) return BRIDGE_ROOT;
  if (!cache.loaded) {
    try {
      cache.md = readBridgeMd();
    } catch {
      cache.md = null;
    }
    cache.loaded = true;
  }
  if (!cache.md) return null;
  try {
    return resolveRepoCwd(cache.md, BRIDGE_ROOT, run.repo);
  } catch {
    return null;
  }
}

function isJsonlFresh(run: Run, cache: BridgeMdCache, freshUntil: number): boolean {
  const cwd = resolveRunCwd(run, cache);
  if (!cwd) return false;
  const projectDir = projectDirFor(cwd);
  const jsonl = join(projectDir, `${run.sessionId}.jsonl`);
  if (!existsSync(jsonl)) return false;
  try {
    const stat = statSync(jsonl);
    return stat.mtimeMs > freshUntil;
  } catch {
    return false;
  }
}

function isHeartbeatFresh(run: Run, freshUntil: number): boolean {
  const ts = getLastHeartbeat(run.sessionId);
  return ts !== null && ts > freshUntil;
}

async function computeStalePatches(
  meta: Meta,
): Promise<Array<{ sessionId: string; patch: Partial<Run> }>> {
  const nowMs = Date.now();
  const queuedCutoff = nowMs - queuedStaleThresholdMs();
  const jsonlFreshUntil = nowMs - jsonlStaleThresholdMs();
  const metaCreated = Date.parse(meta.createdAt);
  const nowIso = new Date().toISOString();
  const cache: BridgeMdCache = { md: null, loaded: false };
  const patches: Array<{ sessionId: string; patch: Partial<Run> }> = [];
  let aliveSidsLazy: Set<string> | null = null;
  const ensureAliveSids = async (): Promise<Set<string>> => {
    if (aliveSidsLazy === null) {
      aliveSidsLazy = await getAliveClaudeSessions();
    }
    return aliveSidsLazy;
  };

  for (const run of meta.runs) {
    let isStale = false;

    if (run.status === "running") {
      const child = getChild(run.sessionId);
      // global registry, etc.). Falling through to the JSONL freshness
      if (child && child.exitCode === null && !child.killed) {
        isStale = false;
      } else if (
        isHeartbeatFresh(run, jsonlFreshUntil) ||
        isJsonlFresh(run, cache, jsonlFreshUntil)
      ) {
        isStale = false;
      } else {
        const aliveSids = await ensureAliveSids();
        isStale = !aliveSids.has(run.sessionId.toLowerCase());
      }
    } else if (run.status === "queued") {
      isStale =
        !Number.isFinite(metaCreated) || metaCreated < queuedCutoff;
    } else {
      continue;
    }

    if (!isStale) continue;
    patches.push({
      sessionId: run.sessionId,
      patch: { status: "stale", endedAt: nowIso },
    });
  }
  return patches;
}

const GR = globalThis as unknown as {
  __bridgeBootSweep?: { done: boolean; inFlight: Promise<void> | null };
};
const bootSweepState = GR.__bridgeBootSweep ?? { done: false, inFlight: null };
GR.__bridgeBootSweep = bootSweepState;

async function bootSweepIfNeeded(): Promise<void> {
  if (bootSweepState.done) return;
  if (process.env.VITEST) {
    bootSweepState.done = true;
    return;
  }
  if (bootSweepState.inFlight) return bootSweepState.inFlight;
  bootSweepState.inFlight = (async () => {
    try {
      if (!existsSync(SESSIONS_DIR)) return;
      const ids = readdirSync(SESSIONS_DIR);
      for (const id of ids) {
        try {
          const dir = join(SESSIONS_DIR, id);
          const meta = readMeta(dir);
          if (!meta) continue;
          const patches = await computeStalePatches(meta);
          if (patches.length > 0) {
            await applyManyRuns(dir, patches);
          }
        } catch (err) {
          console.warn(`boot-sweep: skipped ${id}`, err);
        }
      }
    } finally {
      bootSweepState.done = true;
      bootSweepState.inFlight = null;
    }
  })();
  return bootSweepState.inFlight;
}
