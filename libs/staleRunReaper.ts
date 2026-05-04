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

/**
 * Lazy reaper for runs whose `running` / `queued` state no longer
 * reflects reality. Liveness is decided in three stages — cheapest
 * signal first, OS process probe last — so the reaper stays honest
 * for bridge-spawned AND externally-spawned (e.g. a coordinator
 * launched manually from a Claude Code IDE session) runs:
 *
 *   1. **`spawnRegistry` hit + process alive (`exitCode === null`)**
 *      — the OS process is alive and the bridge owns it. Trust it.
 *      No time cutoff. A coordinator orchestrating long retry chains
 *      can legitimately run for hours; flipping it on a wall-clock
 *      cutoff while the process is healthy lies to the UI.
 *
 *      Registry hit but `exitCode !== null` (or `killed`) is a
 *      zombie: the lifecycle hook should have unregistered on
 *      `exit` but didn't fire (HMR drop on a Next.js dev reload, a
 *      bridge restart with a leftover global-registry entry, …).
 *      Treated as a registry miss so stages 2 + 3 can still flip the
 *      row.
 *
 *   2. **Heartbeat OR `.jsonl` mtime fresh** — two complementary
 *      cheap fallback signals, OR'd together. Heartbeat is the
 *      push-based variant: every PreToolUse hook fires a fire-and-
 *      forget POST to `/api/sessions/<sid>/heartbeat` regardless of
 *      permission mode (the bypass-permissions short-circuit runs
 *      AFTER the heartbeat call), and the bridge stamps an in-memory
 *      timestamp per session. JSONL is the on-disk variant: the
 *      transcript file's mtime advances every time claude writes a
 *      line. We trust the run while EITHER signal is within
 *      `BRIDGE_STALE_RUN_MIN` (default 4 hours).
 *
 *      Why both: heartbeat covers the renamed-repo / missing-bridge.md
 *      case where JSONL can't be located, and the on-disk-flush-delay
 *      case where the OS hasn't propagated the mtime yet. JSONL covers
 *      the bridge-restart case where the in-memory heartbeat map is
 *      empty.
 *
 *      Three real cases land here:
 *        a) An externally-spawned coordinator (user opened Claude
 *           Code in the bridge folder, that session POSTed `/link`
 *           to register itself). It is never in spawnRegistry, but
 *           its `.jsonl` keeps growing as it talks to its tools.
 *        b) Bridge-spawned child whose lifecycle hook didn't fire
 *           (hot-reload dropped the listener). The `.jsonl` is
 *           frozen at its last write — eventually stale, just not
 *           immediately.
 *        c) Zombie registry entry (registry hit but exitCode set —
 *           routed here by case 1's fallthrough). JSONL is also
 *           frozen because the process is genuinely gone, so this
 *           cohort flips stale exactly when 2b would.
 *      Trust the run while the file is fresh; fall through to stage
 *      3 when it isn't.
 *
 *   3. **OS process probe** — the authoritative signal of last
 *      resort. Shells out to PowerShell (Windows) or `ps` (POSIX),
 *      extracts every `--session-id <uuid>` it can find on the
 *      process table, and answers "is this UUID still running?"
 *      directly. Used ONLY when stages 1 + 2 disagree (registry
 *      miss / zombie AND JSONL stale) — that's the cohort where
 *      the cheap signals lie about long-running tasks: a coordinator
 *      idle between agent dispatches, a child blocked on a multi-
 *      hour Bash, a model thinking on a huge context. The probe is
 *      cached for `ALIVE_PROBE_CACHE_MS` (60s) so a sweep across
 *      many tasks pays the cost at most once. Probe failures (no
 *      PowerShell, missing ps, timeout) degrade to "treat as stale",
 *      which preserves the pre-probe contract.
 *
 *   4. **`queued` row past `BRIDGE_QUEUED_STALE_MIN`** — flip to
 *      `stale`. Queued is pre-spawn (promoted to `running` within
 *      milliseconds of the spawn returning). A queued row past the
 *      cutoff means the spawn definitely never promoted. Anchored
 *      to `meta.createdAt` (queued runs have no `startedAt` yet).
 *
 * On the very first call after bridge boot, `bootSweepIfNeeded` walks
 * every task's meta and flips zombie `running`/`queued` rows in bulk
 * so the UI shows truth from the first render. Idempotent; no
 * background timer or cron.
 */

const DEFAULT_QUEUED_STALE_MIN = 2;
/**
 * JSONL freshness cutoff for runs the bridge does NOT own
 * (registry-miss). Bumped from the historical 30-min default to 4
 * hours because real tasks routinely outlive 30 min — long-running
 * Bash steps, model-thinking gaps on big context, and externally-
 * spawned coordinators (operator opened `claude` from an IDE and
 * /link'd it) all leave silent gaps in the JSONL that don't mean the
 * process is dead. The boot-sweep on bridge restart still catches
 * truly-dead leftover rows immediately, so the longer cutoff costs
 * nothing on the happy path. Override via `BRIDGE_STALE_RUN_MIN`.
 */
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

/**
 * OS-level process probe — the most authoritative signal for "is this
 * session still running?" the bridge can get without owning the child.
 * Scans the current OS process list once, extracts every
 * `--session-id <uuid>` argument it can find, and returns a Set of
 * those UUIDs. The reaper consults this Set ONLY when both heartbeat
 * AND JSONL freshness have already failed; if the probe sees the
 * process, the run is alive even though both cheap signals are silent
 * (long Bash, model thinking gap, idle externally-spawned coordinator).
 *
 * Per-platform implementation, cheapest signal first:
 *   - **Linux** — read `/proc/<pid>/cmdline` directly via `fs`, no
 *     subprocess call. Each cmdline file is NUL-separated argv;
 *     parsing is a one-pass split. Total cost ~10-30ms even on a
 *     box with hundreds of processes, vs ~50-100ms for `ps` because
 *     we skip the fork+exec.
 *   - **Windows** — PowerShell `Get-CimInstance Win32_Process`. The
 *     CIM query itself is ~1s; -NoProfile keeps shell startup fast.
 *     Native alternatives (NtQuerySystemInformation via FFI, native
 *     module) would shave another few hundred ms but require a build
 *     step the bridge doesn't otherwise need.
 *   - **macOS / other POSIX without /proc** — fall back to `ps -eo
 *     args`. ~50-100ms.
 *
 * Cached at module level for `ALIVE_PROBE_CACHE_MS` so a reaper sweep
 * across many tasks pays the probe cost at most once. Cache window is
 * generous (5 min) because the probe is a last-resort signal — by
 * the time we're invoking it, the cheap signals (heartbeat + JSONL)
 * have already missed by 4+ hours, so the risk of a 5-minute-stale
 * probe result misleading the reaper is negligible. The lifecycle
 * hook + boot-sweep will catch any genuinely-dead row at restart.
 *
 * Probe failures (PowerShell missing, ps absent, /proc unreadable,
 * timeout) return an empty Set, which degrades gracefully to
 * JSONL-only behavior.
 */
const ALIVE_PROBE_CACHE_MS = 5 * 60_000;
const ALIVE_PROBE_TIMEOUT_MS = 5_000;
let aliveSidsCache: { ids: Set<string>; expiresAt: number } | null = null;

const SESSION_ID_RE = /--session-id[\s=\0]+([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/g;

/**
 * Linux fast path: read `/proc/<pid>/cmdline` directly. NUL-separated
 * argv per file; we just concatenate them all into one search blob
 * and let the SESSION_ID_RE pattern (which tolerates `\0` between
 * `--session-id` and the UUID) extract matches. Skips PIDs we can't
 * read (transient race, kernel threads with no cmdline) silently.
 */
function probeAliveOnLinux(): Set<string> {
  const sids = new Set<string>();
  try {
    const entries = readdirSync("/proc");
    for (const entry of entries) {
      // /proc has dirs for each PID plus other entries (cpuinfo,
      // meminfo, …). PIDs are pure digit strings; skipping anything
      // else avoids permission errors on `/proc/sys/...` for the
      // unprivileged bridge process.
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
        // Process exited between readdir and readFile, or the kernel
        // thread doesn't have a cmdline. Skip silently.
      }
    }
  } catch {
    /* /proc unreadable — caller falls back to empty Set */
  }
  return sids;
}

async function probeAliveClaudeSessions(): Promise<Set<string>> {
  // Linux fast path: no subprocess fork, just /proc reads.
  if (process.platform === "linux") {
    return probeAliveOnLinux();
  }
  const sids = new Set<string>();
  try {
    let cmdOutput = "";
    if (process.platform === "win32") {
      // Get-CimInstance is the modern replacement for the deprecated
      // wmic. Returns one CommandLine per process; null lines (PIDs
      // we lack visibility into) become empty rows we just skip.
      // -NoProfile keeps startup ~200ms by skipping $PROFILE; the
      // actual CIM query is the dominant cost (~1s on a fresh shell).
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
      // POSIX without /proc (macOS, BSD): `ps -eo args` prints one
      // command line per process. ~50-100ms.
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
    // Probe failed — return empty Set. The reaper falls back to
    // JSONL-only behavior, which is the pre-probe contract.
  }
  return sids;
}

async function getAliveClaudeSessions(): Promise<Set<string>> {
  // Tests mock the registry directly; running PowerShell / ps inside
  // a test harness adds slow non-deterministic noise. The boot-sweep
  // already short-circuits in VITEST for the same reason.
  if (process.env.VITEST) return new Set();
  const now = Date.now();
  if (aliveSidsCache && aliveSidsCache.expiresAt > now) {
    return aliveSidsCache.ids;
  }
  const ids = await probeAliveClaudeSessions();
  aliveSidsCache = { ids, expiresAt: now + ALIVE_PROBE_CACHE_MS };
  return ids;
}

/**
 * Reap one task's stale runs in place. Returns the meta with the
 * mutations already on disk — caller can hand it straight to the API
 * response. If the directory has no meta, returns null.
 *
 * H6: previously this looped `updateRun` per stale run, doing N full
 * read-modify-write cycles. Now we do **one** read, build the patch
 * list in memory, and call `applyManyRuns` which performs a single
 * locked write while still emitting per-run lifecycle events for the
 * SSE stream (so the UI's transition animation still fires per row).
 */
export async function reapStaleRunsForDir(sessionsDir: string): Promise<Meta | null> {
  await bootSweepIfNeeded();
  const meta = readMeta(sessionsDir);
  if (!meta) return null;
  const patches = await computeStalePatches(meta);
  if (patches.length === 0) return meta;
  return (await applyManyRuns(sessionsDir, patches)) ?? meta;
}

/**
 * Resolve the repo cwd for a run so the reaper can locate its
 * `.jsonl`. Coordinator-style runs (those whose `repo` matches the
 * bridge folder) live in `BRIDGE_ROOT`; everything else goes through
 * the apps registry. Returns `null` when the repo is unknown
 * (renamed / deleted), which the caller treats as "can't verify
 * liveness — assume stale".
 *
 * `bridgeMdCache` lets one boot-sweep iteration reuse a single
 * `readBridgeMd` parse instead of re-reading per run. Cleared after
 * the sweep finishes; per-task callers pay one parse per request,
 * which is already in the noise.
 */
type BridgeMdCache = { md: ReturnType<typeof readBridgeMd> | null; loaded: boolean };

function resolveRunCwd(run: Run, cache: BridgeMdCache): string | null {
  // Bridge-relative runs live at BRIDGE_ROOT regardless of role —
  // the coordinator self-registers with `repo: BRIDGE_FOLDER`, and
  // any orchestration agent the bridge spawns inside its own tree
  // shares the cwd. Cheap fast path before we touch bridge.md.
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

/**
 * True when the run's `.jsonl` was written to within the JSONL-stale
 * cutoff. Returns `false` when the file is missing or the cwd can't
 * be resolved — caller treats both as "can't prove liveness, mark
 * stale" so a renamed-repo or never-existed transcript doesn't
 * ghost forever.
 */
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

/**
 * True when we received a heartbeat for this run within the freshness
 * window. The PreToolUse hook fires a fire-and-forget POST to
 * `/api/sessions/<sid>/heartbeat` on every tool boundary, regardless
 * of permission mode. The store is in-memory (see `libs/heartbeat.ts`),
 * so a `null` response means "we never heard from this session" — the
 * caller treats that the same as "JSONL not fresh" and falls through
 * to the OS-probe fallback.
 *
 * Heartbeat is complementary to JSONL freshness, not a replacement:
 *   - JSONL is per-message (assistant + tool_use lines), heartbeat is
 *     per-tool-use boundary, so during active work heartbeats arrive
 *     at least as often as JSONL writes.
 *   - JSONL needs a resolvable cwd to find the file; heartbeat doesn't
 *     need any path resolution. So a renamed-repo or missing-bridge.md
 *     run that JSONL can't locate may still be alive via heartbeats.
 *   - On bridge restart heartbeats reset to empty; JSONL persists.
 *
 * Together: trust the run if EITHER signal is fresh.
 */
function isHeartbeatFresh(run: Run, freshUntil: number): boolean {
  const ts = getLastHeartbeat(run.sessionId);
  return ts !== null && ts > freshUntil;
}

/**
 * Given a meta snapshot, return the patch list for any rows that
 * should flip to `stale`. Touches the filesystem to stat per-run
 * `.jsonl` files (fallback liveness check) and may shell out once
 * to PowerShell / `ps` for the OS process probe (last-resort
 * liveness check, cached for 60s). No writes happen here. Exported
 * only for the boot-sweep helper below; outside callers should use
 * `reapStaleRunsForDir` so the writes go through the meta lock.
 *
 * Async because the OS probe is async; the result is the same patch
 * list shape as before.
 */
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
  // Lazy-load the OS probe only when at least one candidate would
  // otherwise be flipped on a JSONL miss. Avoids the ~1-2s PowerShell
  // round-trip on the happy path (every run is either registry-alive
  // or JSONL-fresh).
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
      // Registry hit + process actually alive — trust the row with no
      // time cutoff (a coordinator orchestrating long retry chains
      // can legitimately run for hours).
      //
      // Registry hit + process exited (`exitCode !== null`) is a
      // zombie: the lifecycle hook should have unregistered on `exit`
      // but didn't fire (HMR drop, bridge restart with a leftover
      // global registry, etc.). Falling through to the JSONL freshness
      // check lets the reaper still flip the row when the transcript
      // confirms the process is gone — without this, a zombie entry
      // would stay "running" forever.
      if (child && child.exitCode === null && !child.killed) {
        isStale = false;
      } else if (
        isHeartbeatFresh(run, jsonlFreshUntil) ||
        isJsonlFresh(run, cache, jsonlFreshUntil)
      ) {
        // No registry hit (or zombie), but EITHER the in-memory
        // heartbeat store OR the on-disk transcript was updated
        // within the cutoff. Both are cheap "agent activity" signals;
        // having two independent sources covers each other's failure
        // modes (bridge restart loses heartbeats; renamed repo
        // unresolves the JSONL path).
        isStale = false;
      } else {
        // Last resort: ask the OS whether the `claude --session-id
        // <uuid>` process is still alive. JSONL freshness has failed
        // either because the file is missing, the cwd doesn't
        // resolve, or the transcript hasn't moved in 4+ hours. Any
        // of those can mean "process is fine but waiting on a long
        // tool call" rather than "process is dead", and the only way
        // to tell without owning the child is to look at the process
        // table. The probe runs once per reap (cached), so a sweep
        // across many candidates costs one shell-out, not N.
        const aliveSids = await ensureAliveSids();
        isStale = !aliveSids.has(run.sessionId.toLowerCase());
      }
    } else if (run.status === "queued") {
      // Queued is pre-spawn — promoted to running within
      // milliseconds when the spawn returns. A queued row past the
      // cutoff means the spawn definitely never promoted. Registry
      // and JSONL checks are skipped on purpose: queued runs were
      // never registered and have no transcript yet.
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

/**
 * One-shot sweep of every task's meta on first reaper call after bridge
 * boot. The previous bridge process (if any) tree-killed all spawned
 * children when it died, so any `running` row carried over in meta is
 * by definition a zombie. We flip them to `stale` in bulk so the UI
 * starts honest from the very first render — without this, each task's
 * status would only correct itself once the user happened to open it.
 *
 * Guarded by a module-level flag so concurrent first-callers cannot
 * trigger overlapping sweeps. Failures are swallowed: a bad meta file
 * mustn't block the rest of the sweep, and the per-task reaper will
 * retry the bad one on its next call anyway.
 */
let bootSweepDone = false;
let bootSweepInFlight: Promise<void> | null = null;
async function bootSweepIfNeeded(): Promise<void> {
  if (bootSweepDone) return;
  // Vitest runs against tmp dirs but `SESSIONS_DIR` resolves to the
  // bridge's real sessions/ — sweeping there during tests would mutate
  // the developer's actual meta files. The unit tests for this module
  // exercise reapStaleRunsForDir directly, so the boot path adds no
  // coverage anyway.
  if (process.env.VITEST) {
    bootSweepDone = true;
    return;
  }
  if (bootSweepInFlight) return bootSweepInFlight;
  bootSweepInFlight = (async () => {
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
      bootSweepDone = true;
      bootSweepInFlight = null;
    }
  })();
  return bootSweepInFlight;
}
