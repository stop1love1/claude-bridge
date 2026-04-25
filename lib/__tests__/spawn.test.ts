import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCoordinatorArgs } from "../spawn";
import { appendRun, createMeta, readMeta, updateRun } from "../meta";

describe("buildCoordinatorArgs", () => {
  it("pins the session-id and ends with -p (prompt is piped via stdin)", () => {
    const sessionId = "550e8400-e29b-41d4-a716-446655440000";
    const args = buildCoordinatorArgs(
      { role: "coordinator", taskId: "t_20260424_001", prompt: "Do the thing." },
      sessionId,
    );
    expect(args[0]).toBe("--session-id");
    expect(args[1]).toBe(sessionId);
    expect(args[args.length - 1]).toBe("-p");
  });

  it("requests stream-json output so stdout carries token deltas", () => {
    const args = buildCoordinatorArgs(
      { role: "coordinator", taskId: "t_x", prompt: "" },
      "id",
    );
    expect(args).toContain("--output-format");
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(args).toContain("--verbose");
    expect(args).toContain("--include-partial-messages");
  });

  it("emits no model / effort / permission-mode flag when settings absent", () => {
    const args = buildCoordinatorArgs(
      { role: "coordinator", taskId: "t_x", prompt: "" },
      "id",
    );
    expect(args).not.toContain("--model");
    expect(args).not.toContain("--effort");
    expect(args).not.toContain("--permission-mode");
  });

  it("forwards valid settings as flags", () => {
    const args = buildCoordinatorArgs(
      {
        role: "coordinator",
        taskId: "t_x",
        prompt: "",
        settings: { mode: "acceptEdits", effort: "high", model: "opus" },
      },
      "id",
    );
    expect(args).toContain("--permission-mode");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(args).toContain("--effort");
    expect(args[args.indexOf("--effort") + 1]).toBe("high");
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("opus");
  });

  it("rejects invalid settings values silently", () => {
    const args = buildCoordinatorArgs(
      {
        role: "coordinator",
        taskId: "t_x",
        prompt: "",
        // @ts-expect-error — explicitly testing runtime rejection
        settings: { mode: "rm -rf /", effort: "ULTRA", model: "../etc/passwd" },
      },
      "id",
    );
    expect(args).not.toContain("--permission-mode");
    expect(args).not.toContain("--effort");
    expect(args).not.toContain("--model");
  });
});

/**
 * H4 regression: the route handler used to call `appendRun` AFTER the
 * spawn, so a thrown spawn left a live (or attempted) child with no
 * matching row in meta.json. Spec is now:
 *
 *   1. appendRun({status:"queued", startedAt:null})
 *   2. try { spawn() } catch { updateRun({status:"failed", endedAt:now}); rethrow }
 *   3. updateRun({status:"running", startedAt:now})
 *
 * This test simulates that flow with a synthetic "spawn" that throws,
 * and asserts the meta.json on disk ends up with one row, status
 * "failed", endedAt populated.
 */
describe("appendRun-before-spawn (H4)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "spawn-h4-"));
  });

  const HEADER = {
    taskId: "t_20260424_h4",
    taskTitle: "agents H4",
    taskBody: "exercise spawn-failure path",
    taskStatus: "todo" as const,
    taskSection: "TODO" as const,
    taskChecked: false,
    createdAt: "2026-04-24T10:00:00Z",
  };

  const SESSION_ID = "h4-failed-session";

  async function fakeRouteFlow(opts: { spawnThrows: boolean }) {
    await appendRun(tmp, {
      sessionId: SESSION_ID,
      role: "coder",
      repo: "fake-repo",
      status: "queued",
      startedAt: null,
      endedAt: null,
      parentSessionId: null,
    });

    try {
      if (opts.spawnThrows) {
        throw new Error("ENOENT: claude binary not on PATH");
      }
      // Simulate a successful spawn promotion path so the success
      // branch is also exercised by the second case below.
      await updateRun(tmp, SESSION_ID, {
        status: "running",
        startedAt: "2026-04-24T10:00:01Z",
      });
      return { ok: true as const };
    } catch (err) {
      await updateRun(tmp, SESSION_ID, {
        status: "failed",
        endedAt: "2026-04-24T10:00:01Z",
      });
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  }

  it("records run as failed when spawn throws — no orphan window", async () => {
    createMeta(tmp, HEADER);
    const result = await fakeRouteFlow({ spawnThrows: true });
    expect(result.ok).toBe(false);

    const meta = readMeta(tmp);
    expect(meta).not.toBeNull();
    expect(meta!.runs).toHaveLength(1);
    const run = meta!.runs[0];
    expect(run.sessionId).toBe(SESSION_ID);
    expect(run.status).toBe("failed");
    expect(run.endedAt).toBe("2026-04-24T10:00:01Z");
    // startedAt stays null because the spawn never succeeded — the run
    // was queued and immediately failed without ever going running.
    expect(run.startedAt).toBeNull();
  });

  it("promotes queued → running on successful spawn", async () => {
    createMeta(tmp, HEADER);
    const result = await fakeRouteFlow({ spawnThrows: false });
    expect(result.ok).toBe(true);

    const meta = readMeta(tmp);
    const run = meta!.runs[0];
    expect(run.status).toBe("running");
    expect(run.startedAt).toBe("2026-04-24T10:00:01Z");
    expect(run.endedAt).toBeNull();
  });
});
