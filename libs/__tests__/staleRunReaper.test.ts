import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { createMeta, appendRun, readMeta } from "../meta";
import { reapStaleRunsForDir } from "../staleRunReaper";
import { registerChild, unregisterChild } from "../spawnRegistry";
import { BRIDGE_FOLDER, BRIDGE_ROOT } from "../paths";
import { pathToSlug } from "../sessions";

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "reaper-")); });
afterEach(() => {
  delete process.env.BRIDGE_QUEUED_STALE_MIN;
});

/**
 * Build a fake ChildProcess for the spawn registry so a test can
 * assert "process alive → run stays running". Only the `on('exit')`
 * subscription is exercised; the EventEmitter satisfies it.
 */
function fakeChild(): ChildProcess {
  return new EventEmitter() as unknown as ChildProcess;
}

const HEADER_FRESH = {
  taskId: "t_reaper_fresh",
  taskTitle: "fresh task",
  taskBody: "",
  taskStatus: "todo" as const,
  taskSection: "TODO" as const,
  taskChecked: false,
  // Set in each test based on age requirement.
  createdAt: new Date().toISOString(),
};

function withCreatedAt(iso: string) {
  return { ...HEADER_FRESH, createdAt: iso };
}

describe("reapStaleRunsForDir — H4 queued state", () => {
  it("flips a queued run to failed when meta.createdAt is older than the cutoff", async () => {
    // 5 minutes ago, well past the default 2-minute queued cutoff.
    const oldCreated = new Date(Date.now() - 5 * 60_000).toISOString();
    const dir = join(tmp, "t_q1");
    createMeta(dir, withCreatedAt(oldCreated));
    await appendRun(dir, {
      sessionId: "stuck-queued",
      role: "coder",
      repo: "fake",
      status: "queued",
      startedAt: null,
      endedAt: null,
    });

    const meta = await reapStaleRunsForDir(dir);
    expect(meta).not.toBeNull();
    const run = meta!.runs[0];
    expect(run.status).toBe("stale");
    expect(run.endedAt).not.toBeNull();

    // Confirm persisted.
    const reread = readMeta(dir);
    expect(reread!.runs[0].status).toBe("stale");
  });

  it("leaves a freshly-queued run alone (within the cutoff window)", async () => {
    const dir = join(tmp, "t_q2");
    createMeta(dir, HEADER_FRESH); // createdAt = now
    await appendRun(dir, {
      sessionId: "fresh-queued",
      role: "coder",
      repo: "fake",
      status: "queued",
      startedAt: null,
      endedAt: null,
    });

    const meta = await reapStaleRunsForDir(dir);
    expect(meta!.runs[0].status).toBe("queued");
  });

  it("respects BRIDGE_QUEUED_STALE_MIN env override", async () => {
    process.env.BRIDGE_QUEUED_STALE_MIN = "0.01"; // ~600ms cutoff
    const dir = join(tmp, "t_q3");
    // createdAt = 30s ago — well past 0.01 min (=600ms)
    const old = new Date(Date.now() - 30_000).toISOString();
    createMeta(dir, withCreatedAt(old));
    await appendRun(dir, {
      sessionId: "queued-via-env",
      role: "coder",
      repo: "fake",
      status: "queued",
      startedAt: null,
      endedAt: null,
    });

    const meta = await reapStaleRunsForDir(dir);
    expect(meta!.runs[0].status).toBe("stale");
  });

  it("still reaps stale running rows (registry-miss) alongside queued rows", async () => {
    const dir = join(tmp, "t_q4");
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    createMeta(dir, withCreatedAt(old));
    await appendRun(dir, {
      sessionId: "old-queued",
      role: "coder",
      repo: "fake",
      status: "queued",
      startedAt: null,
      endedAt: null,
    });
    await appendRun(dir, {
      sessionId: "old-running-no-registry",
      role: "coder",
      repo: "fake",
      status: "running",
      // No registerChild() for this sid → registry-miss → stale.
      startedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      endedAt: null,
    });

    const meta = await reapStaleRunsForDir(dir);
    expect(meta!.runs[0].status).toBe("stale");
    expect(meta!.runs[1].status).toBe("stale");
  });

  it("does NOT flip a long-running row to stale when the process is still in the registry", async () => {
    // Regression test for the case in the screenshot: a coordinator
    // orchestrating multiple child retries had been running 30+ min
    // and was reaped despite the OS process being healthy. The new
    // policy is "OS registry is the only signal" — alive = running,
    // gone = stale, no time cutoff in between.
    const dir = join(tmp, "t_long_alive");
    createMeta(dir, withCreatedAt(new Date(Date.now() - 2 * 60 * 60_000).toISOString()));
    const sid = "long-alive-coordinator";
    await appendRun(dir, {
      sessionId: sid,
      role: "coordinator",
      repo: "claude-bridge",
      status: "running",
      // 2 hours ago — would have been flipped under the old 30-min cutoff.
      startedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
      endedAt: null,
    });
    const child = fakeChild();
    registerChild(sid, child);
    try {
      const meta = await reapStaleRunsForDir(dir);
      expect(meta!.runs[0].status).toBe("running");
      expect(meta!.runs[0].endedAt).toBeNull();
    } finally {
      unregisterChild(sid);
    }
  });

  it("flips a running row to stale immediately when the process is gone AND no JSONL exists, regardless of age", async () => {
    const dir = join(tmp, "t_gone");
    createMeta(dir, HEADER_FRESH);
    await appendRun(dir, {
      sessionId: "gone-fresh",
      role: "coder",
      repo: "fake-no-such-repo",
      status: "running",
      // Started 5 seconds ago — fresh by any wall-clock measure, but
      // never registered AND repo isn't in bridge.md → can't even
      // locate a `.jsonl` to fall back on → stale.
      startedAt: new Date(Date.now() - 5_000).toISOString(),
      endedAt: null,
    });

    const meta = await reapStaleRunsForDir(dir);
    expect(meta!.runs[0].status).toBe("stale");
  });

  it("keeps a registry-miss running row alive when its JSONL was written within the cutoff", async () => {
    // Externally-spawned coordinator scenario: a Claude Code IDE
    // session POSTed `/link` to register itself, but never went
    // through the bridge's spawn path so it isn't in spawnRegistry.
    // Its `.jsonl` keeps growing as it dispatches agents — that's
    // the only liveness signal we have. Threshold is generous (30
    // min by default) since coordinators idle between child runs.
    const dir = join(tmp, "t_external_alive");
    createMeta(dir, HEADER_FRESH);
    const sid = "0123abcd-4567-89ef-cdef-aaaaaaaaaaaa";
    await appendRun(dir, {
      sessionId: sid,
      role: "coordinator",
      // BRIDGE_FOLDER (basename of the actual bridge dir) — hits the
      // fast path in resolveRunCwd that skips bridge.md parsing.
      repo: BRIDGE_FOLDER,
      status: "running",
      startedAt: new Date(Date.now() - 90 * 60_000).toISOString(), // 90 min ago
      endedAt: null,
    });

    // Plant a fresh `.jsonl` at the path the reaper will look up.
    // We write to the real `~/.claude/projects/<slug-of-BRIDGE_ROOT>/`
    // because mocking `homedir` would require resetting the module
    // graph mid-test. The file is removed in the cleanup block so
    // it doesn't pollute the developer's machine.
    const slug = pathToSlug(BRIDGE_ROOT);
    const projectsDir = join(process.env.USERPROFILE || process.env.HOME || "", ".claude", "projects", slug);
    mkdirSync(projectsDir, { recursive: true });
    const jsonlPath = join(projectsDir, `${sid}.jsonl`);
    writeFileSync(jsonlPath, '{"type":"user","message":{"content":"hi"}}\n');
    // Force mtime to "now" — Date.now() / 1000 in seconds.
    const now = Date.now() / 1000;
    utimesSync(jsonlPath, now, now);

    try {
      const meta = await reapStaleRunsForDir(dir);
      expect(meta!.runs[0].status).toBe("running");
      expect(meta!.runs[0].endedAt).toBeNull();
    } finally {
      try { rmSync(jsonlPath, { force: true }); } catch { /* best-effort */ }
    }
  });

  it("flips a registry-miss running row to stale when its JSONL is older than the cutoff", async () => {
    const dir = join(tmp, "t_external_idle");
    createMeta(dir, HEADER_FRESH);
    const sid = "0123abcd-4567-89ef-cdef-bbbbbbbbbbbb";
    await appendRun(dir, {
      sessionId: sid,
      role: "coordinator",
      repo: BRIDGE_FOLDER,
      status: "running",
      startedAt: new Date(Date.now() - 90 * 60_000).toISOString(),
      endedAt: null,
    });

    const slug = pathToSlug(BRIDGE_ROOT);
    const projectsDir = join(process.env.USERPROFILE || process.env.HOME || "", ".claude", "projects", slug);
    mkdirSync(projectsDir, { recursive: true });
    const jsonlPath = join(projectsDir, `${sid}.jsonl`);
    writeFileSync(jsonlPath, '{"type":"user","message":{"content":"hi"}}\n');
    // Backdate mtime to 60 min ago — past the default 30-min cutoff.
    const old = (Date.now() - 60 * 60_000) / 1000;
    utimesSync(jsonlPath, old, old);

    try {
      const meta = await reapStaleRunsForDir(dir);
      expect(meta!.runs[0].status).toBe("stale");
    } finally {
      try { rmSync(jsonlPath, { force: true }); } catch { /* best-effort */ }
    }
  });

  it("does not touch done / failed rows", async () => {
    const dir = join(tmp, "t_q5");
    const old = new Date(Date.now() - 60 * 60_000).toISOString();
    createMeta(dir, withCreatedAt(old));
    await appendRun(dir, {
      sessionId: "done-already",
      role: "coder",
      repo: "fake",
      status: "done",
      startedAt: old,
      endedAt: old,
    });
    await appendRun(dir, {
      sessionId: "failed-already",
      role: "coder",
      repo: "fake",
      status: "failed",
      startedAt: old,
      endedAt: old,
    });

    const meta = await reapStaleRunsForDir(dir);
    expect(meta!.runs[0].status).toBe("done");
    expect(meta!.runs[1].status).toBe("failed");
    // endedAt unchanged
    expect(meta!.runs[1].endedAt).toBe(old);
  });
});
