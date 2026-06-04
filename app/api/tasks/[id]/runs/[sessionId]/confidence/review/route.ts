/**
 * Reliability Amplifier (B2) — resolve a low-confidence HOLD.
 *
 * When a run scored below the confidence threshold, postExitFlow committed
 * locally but skipped the outward push/integration and stamped
 * `run.confidence.heldAt`. This operator-only endpoint clears that hold:
 *
 *   - `action: "ship"`    → push the held work (autoCommitAndPush, push on)
 *                           then clear the hold + record `reviewedBy`.
 *   - `action: "dismiss"` → just clear the hold (operator reviewed, will
 *                           ship later via the per-run commit UI).
 */
import { NextResponse, type NextRequest } from "next/server";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_GIT_SETTINGS, getApp } from "@/libs/apps";
import { autoCommitAndPush, mergeIntoTargetBranch, readCurrentBranch } from "@/libs/gitOps";
import { runDevopsAgent } from "@/libs/devops";
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
  // Operator-only — confidence holds are the operator's call, never a guest's.
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
  if (action === "ship") {
    const app = getApp(run.repo);
    const cwd =
      run.worktreePath && existsSync(run.worktreePath)
        ? run.worktreePath
        : app && existsSync(app.path)
          ? app.path
          : null;
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
      pushResult = { ok: r.ok, message: r.message, error: r.error ?? null };
    } catch (err) {
      return NextResponse.json(
        { error: "ship failed", detail: safeErrorMessage(err, "unknown") },
        { status: 500 },
      );
    }

    // Re-run the post-success integration that the hold skipped (non-worktree
    // only — worktree runs integrate on cleanup, never held in v1). Failures
    // here are surfaced, not fatal: the push already landed.
    if (app && !run.worktreePath && app.git.integrationMode !== "none" && app.git.mergeTargetBranch.trim()) {
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
