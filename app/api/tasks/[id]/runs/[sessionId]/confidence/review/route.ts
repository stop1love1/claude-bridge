import { NextResponse, type NextRequest } from "next/server";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_GIT_SETTINGS, getApp } from "@/libs/apps";
import { autoCommitAndPush, mergeIntoTargetBranch, readCurrentBranch } from "@/libs/gitOps";
import { runDevopsAgent } from "@/libs/devops";
import { markMergeNotPushed, performWorktreeMergeBack } from "@/libs/runLifecycle";
import { readMeta, updateRun } from "@/libs/meta";
import { SESSIONS_DIR } from "@/libs/paths";
import { isValidTaskId } from "@/libs/tasks";
import { badRequest, isValidSessionId } from "@/libs/validate";
import { checkCsrf } from "@/libs/csrf";
import { verifyRequestActor } from "@/libs/auth";
import { safeErrorMessage } from "@/libs/errorResponse";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; sessionId: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const { id, sessionId } = await ctx.params;
  if (!isValidTaskId(id)) return badRequest("invalid task id");
  if (!isValidSessionId(sessionId)) return badRequest("invalid sessionId");

  const csrf = checkCsrf(req);
  if (!csrf.ok) {
    return NextResponse.json({ error: "csrf check failed", reason: csrf.reason ?? null }, { status: 403 });
  }
  const actor = verifyRequestActor(req);
  if (actor?.kind !== "operator") {
    return NextResponse.json({ error: "operator only" }, { status: 403 });
  }

  let body: { action?: unknown };
  try { body = (await req.json()) as { action?: unknown }; } catch { return badRequest("invalid JSON body"); }
  const action = body.action === "ship" || body.action === "dismiss" ? body.action : null;
  if (!action) return badRequest("action must be 'ship' or 'dismiss'");

  const dir = join(SESSIONS_DIR, id);
  const meta = readMeta(dir);
  if (!meta) return NextResponse.json({ error: "task not found" }, { status: 404 });
  const run = meta.runs.find((r) => r.sessionId === sessionId);
  if (!run) return NextResponse.json({ error: "run not found" }, { status: 404 });
  if (!run.confidence?.heldAt) {
    return NextResponse.json({ error: "run is not held" }, { status: 409 });
  }

  let pushResult: { ok: boolean; message: string; error?: string | null } | null = null;
  let integrationResult: { kind: string; ok: boolean; message: string } | null = null;
  if (action === "ship" && run.worktreePath) {
    const app = getApp(run.repo);
    if (!app) {
      return NextResponse.json({ error: "app not found for this run's repo" }, { status: 404 });
    }
    if (!existsSync(run.worktreePath)) {
      return NextResponse.json({ error: "worktree no longer exists" }, { status: 404 });
    }
    const message = `[${id}] ${meta.taskTitle} (operator-approved after low-confidence review)`;
    const mb = await performWorktreeMergeBack({
      app,
      run,
      tid: id,
      title: meta.taskTitle,
      t: `confidence-ship:${sessionId.slice(0, 8)}`,
      dir,
      message,
    });
    if (!mb.ok && mb.stage === "merge") {
      return NextResponse.json(
        {
          ok: false,
          action,
          error: "merge-back failed — hold retained, resolve and retry ship",
          stage: mb.stage,
          detail: mb.detail ?? null,
          confidence: run.confidence,
          push: null,
          integration: null,
        },
        { status: 409 },
      );
    }
    pushResult = {
      ok: mb.ok,
      message: mb.ok
        ? "worktree merge-back completed (merge, worktree integration, live-tree push)"
        : `worktree merge-back partially failed at ${mb.stage ?? "unknown"} stage (merge landed): ${mb.detail ?? "see server logs"}`,
      error: mb.ok ? null : mb.detail ?? null,
    };
  } else if (action === "ship") {
    const app = getApp(run.repo);
    const cwd = app && existsSync(app.path) ? app.path : null;
    if (!cwd) {
      return NextResponse.json({ error: "cannot resolve a working tree for this run" }, { status: 404 });
    }
    const message = `[${id}] ${meta.taskTitle} (operator-approved after low-confidence review)`;
    try {
      const r = await autoCommitAndPush(
        cwd,
        { ...(app?.git ?? DEFAULT_GIT_SETTINGS), autoCommit: true, autoPush: true },
        message,
      );
      if (!r.ok) {
        await markMergeNotPushed(
          dir,
          sessionId,
          `SHIP-INCOMPLETE: live-tree ship (commit and/or push) failed: ${r.message}`,
          r.error,
        );
        return NextResponse.json(
          {
            ok: false,
            action,
            error: "ship failed — hold retained, resolve and retry ship",
            stage: "commit-or-push",
            detail: r.error ?? r.message,
            confidence: run.confidence,
            push: { ok: false, message: r.message, error: r.error ?? null },
            integration: null,
          },
          { status: 409 },
        );
      }
      pushResult = { ok: r.ok, message: r.message, error: r.error ?? null };
    } catch (err) {
      return NextResponse.json(
        { error: "ship failed", detail: safeErrorMessage(err, "unknown") },
        { status: 500 },
      );
    }

    if (app && app.git.integrationMode !== "none" && app.git.mergeTargetBranch.trim()) {
      try {
        const sourceBranch = await readCurrentBranch(cwd);
        if (!sourceBranch) {
          integrationResult = { kind: app.git.integrationMode, ok: false, message: "skipped: detached HEAD / non-git tree" };
        } else if (app.git.integrationMode === "auto-merge") {
          const m = await mergeIntoTargetBranch({
            cwd,
            sourceBranch,
            targetBranch: app.git.mergeTargetBranch,
            message: `merge ${sourceBranch} → ${app.git.mergeTargetBranch} (${id}, operator-approved)`,
            push: app.git.autoPush,
            pushTimeoutMs: app.git.pushTimeoutMs,
          });
          integrationResult = { kind: "auto-merge", ok: m.ok, message: m.message };
        } else if (app.git.integrationMode === "pull-request") {
          const d = await runDevopsAgent({
            appPath: cwd,
            taskId: id,
            finishedRun: run,
            taskTitle: meta.taskTitle,
            taskBody: meta.taskBody,
            sourceBranch,
            targetBranch: app.git.mergeTargetBranch,
          });
          integrationResult = { kind: "pull-request", ok: d.status === "opened" || d.status === "exists", message: `${d.status} — ${d.reason}` };
        }
      } catch (err) {
        integrationResult = { kind: app.git.integrationMode, ok: false, message: safeErrorMessage(err, "integration failed") };
      }
    }
  }

  const reviewedBy = { label: "operator", at: new Date().toISOString() };
  const updated = await updateRun(dir, sessionId, {
    confidence: { ...run.confidence, heldAt: null, reviewedBy },
  });

  return NextResponse.json({
    ok: true,
    action,
    confidence: updated.run?.confidence ?? null,
    push: pushResult,
    integration: integrationResult,
  });
}
