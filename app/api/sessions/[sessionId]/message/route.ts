import { NextResponse, type NextRequest } from "next/server";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveRepoCwd } from "@/libs/repos";
import { BRIDGE_ROOT, SESSIONS_DIR, readBridgeMd } from "@/libs/paths";
import { sendToLiveSession, spawnFreeSession, waitEarlyFailure, type ChatSettings } from "@/libs/spawn";
import { resumeSessionWithLifecycle } from "@/libs/resumeSession";
import { projectDirFor } from "@/libs/sessions";
import { freeSessionSettingsPath, writeSessionSettings } from "@/libs/permissionSettings";
import { setSessionBypass } from "@/libs/sessionBypass";
import { badRequest, isValidEffort, isValidSessionId, isValidUserPermissionMode } from "@/libs/validate";
import { findTaskBySessionId, updateTask } from "@/libs/tasksStore";
import { SECTION_DOING, SECTION_DONE } from "@/libs/tasks";
import { getApp, isValidAppName } from "@/libs/apps";
import { verifyRequestActor } from "@/libs/auth";
import { readIntake, readMeta } from "@/libs/meta";
import { guestBoundRepoValue } from "@/libs/guestSessionRepo";
import { scrubPaths, serverError } from "@/libs/errorResponse";
import { ok } from "@/libs/apiResponse";
import { isAlive } from "@/libs/sessionEvents";
import { withInFlight } from "@/libs/inFlight";
import { acquireRepoReservation, releaseRepoReservation } from "@/libs/repoReservation";
import { evaluatePlanGate } from "@/libs/planGate";
import { readPlanGateConfig } from "@/libs/planGateConfig";
import {
  dequeueMessage,
  enqueueMessage,
  queueLength,
  type QueuedMessage,
} from "@/libs/messageQueue";
import { logError, logInfo, logWarn } from "@/libs/log";

function attachQueueDrain(
  child: ChildProcess,
  sessionId: string,
  onIdle: () => void,
): void {
  let settled = false;
  child.once("exit", () => {
    if (settled) return;
    settled = true;
    const next = dequeueMessage(sessionId);
    if (!next) {
      onIdle();
      return;
    }
    try {
      const drained = resumeSessionWithLifecycle({
        cwd: next.cwd,
        sessionId,
        message: next.message,
        settings: next.settings,
        settingsPath: next.settingsPath,
        context: next.context ?? `chat-queued ${sessionId.slice(0, 8)}`,
      });
      attachQueueDrain(drained, sessionId, onIdle);
      logInfo(
        "msg-queue",
        `drained queued message for ${sessionId.slice(0, 8)} (${queueLength(sessionId)} still pending)`,
      );
    } catch (e) {
      logError("msg-queue", "drain spawn failed", e, {
        sessionId: sessionId.slice(0, 8),
      });
      onIdle();
    }
  });
  child.once("error", () => {
    if (settled) return;
    settled = true;
    onIdle();
  });
}

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ sessionId: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const { sessionId } = await ctx.params;
  if (!isValidSessionId(sessionId)) return badRequest("invalid sessionId");
  const body = (await req.json()) as { message?: string; repo?: string; settings?: ChatSettings };
  const { message, repo, settings } = body;
  if (!message?.trim()) return NextResponse.json({ error: "message required" }, { status: 400 });
  if (!isValidAppName(repo)) return badRequest("invalid repo");
  if (settings != null && typeof settings !== "object") {
    return badRequest("invalid settings");
  }
  if (settings?.mode !== undefined && !isValidUserPermissionMode(settings.mode)) {
    return badRequest("invalid settings.mode");
  }
  if (settings?.effort !== undefined && !isValidEffort(settings.effort)) {
    return badRequest("invalid settings.effort");
  }

  const actor = verifyRequestActor(req);
  let sessionRepo: string | null = null;
  if (actor?.kind === "guest") {
    const ownerMeta = readMeta(join(SESSIONS_DIR, actor.taskId));
    sessionRepo = ownerMeta?.runs.find((r) => r.sessionId === sessionId)?.repo ?? null;
  }
  const effectiveRepo = guestBoundRepoValue({
    actorKind: actor?.kind === "guest" ? "guest" : "operator",
    callerValue: repo ?? null,
    sessionValue: sessionRepo,
  });

  const md = readBridgeMd();
  const cwd = effectiveRepo ? resolveRepoCwd(md, BRIDGE_ROOT, effectiveRepo) : null;
  if (!cwd) return NextResponse.json({ error: "unknown repo" }, { status: 400 });

  const result = await withInFlight("session:message", sessionId, async () => {
    try {
      const fallbackMode =
        process.env.NEXT_PUBLIC_BRIDGE_ALLOW_BYPASS === "1" ? "bypassPermissions" : "default";
      const effectiveSettings: ChatSettings = {
        ...(settings ?? {}),
        mode: settings?.mode ?? fallbackMode,
      };
      // The env var only reaches a process the bridge spawns, and only at spawn
      // time. Recording the choice lets the permission route honour it for a
      // turn already in flight, and for a session the bridge never spawned.
      //
      // Read from what the caller actually asked for, never from the
      // ALLOW_BYPASS fallback above: a client that simply omits settings must
      // not end up silently auto-approving every tool call in the session.
      setSessionBypass(sessionId, settings?.mode === "bypassPermissions");
      const settingsPath = writeSessionSettings(freeSessionSettingsPath(sessionId));
      const file = join(projectDirFor(cwd), `${sessionId}.jsonl`);

      if (existsSync(file) && isAlive(sessionId)) {
        // Preferred path: hand it straight to the running process, so a message
        // typed mid-run lands in the turn the operator is watching instead of
        // waiting for it to end. Only sessions this bridge spawned have a live
        // child to write to; everything else falls through to the queue below.
        if (sendToLiveSession(sessionId, message)) {
          logInfo(
            "msg-live",
            `delivered message into live session ${sessionId.slice(0, 8)}`,
          );
          return NextResponse.json(
            { sessionId, delivered: "live" },
            { status: 202 },
          );
        }

        const queued: QueuedMessage = {
          message,
          cwd,
          settings: effectiveSettings,
          settingsPath,
          context: `chat-queued ${sessionId.slice(0, 8)}`,
          enqueuedAt: Date.now(),
        };
        const position = enqueueMessage(sessionId, queued);
        logInfo(
          "msg-queue",
          `queued message for ${sessionId.slice(0, 8)} (position ${position})`,
        );
        return NextResponse.json(
          {
            sessionId,
            queued: true,
            position,
          },
          { status: 202 },
        );
      }

      const owningTask = findTaskBySessionId(sessionId);
      const isFreshDispatch = !existsSync(file);

      if (isFreshDispatch && owningTask) {
        const ownerRow = readMeta(join(SESSIONS_DIR, owningTask.id))?.runs.find(
          (r) => r.sessionId === sessionId,
        ) ?? null;
        if (ownerRow) {
          const cfg = readPlanGateConfig();
          const gateApplies = cfg.operatorEnabled || actor?.kind === "guest";
          const intake = readIntake(join(SESSIONS_DIR, owningTask.id));
          const decision = evaluatePlanGate({
            role: ownerRow.role,
            intakeStatus: intake?.status ?? "none",
            gateApplies,
          });
          if (!decision.allowed) {
            return NextResponse.json(
              {
                error: "plan-gate",
                reason: decision.reason,
                intakeStatus: intake?.status ?? "none",
              },
              { status: 423 },
            );
          }
        }
      }

      const app = effectiveRepo ? getApp(effectiveRepo) : null;
      const reservable = !!app && app.git.worktreeMode !== "enabled";
      if (reservable && app) {
        const reservation = acquireRepoReservation(app.name, sessionId);
        if (!reservation.ok) {
          return NextResponse.json(
            {
              error: "repo reserved",
              reason:
                `app "${app.name}" has worktreeMode disabled, so only one run may touch its shared working tree at a time; ` +
                `session ${reservation.heldBy} currently holds it — wait for it to finish, kill it, or enable worktreeMode to allow concurrent runs`,
              repo: app.name,
              heldBy: reservation.heldBy ?? null,
            },
            { status: 409 },
          );
        }
      }
      const releaseReservation = () => {
        if (reservable && app) releaseRepoReservation(app.name, sessionId);
      };

      let child: ChildProcess;
      try {
        child = existsSync(file)
          ? resumeSessionWithLifecycle({
              cwd,
              sessionId,
              message,
              settings: effectiveSettings,
              settingsPath,
              context: `chat-resume ${sessionId.slice(0, 8)}`,
            })
          : spawnFreeSession(cwd, message, effectiveSettings, settingsPath, sessionId).child;
      } catch (e) {
        releaseReservation();
        return NextResponse.json(serverError(e, "sessions:message"), { status: 500 });
      }

      attachQueueDrain(child, sessionId, releaseReservation);

      const failure = await waitEarlyFailure(child, 1500);
      if (failure) {
        const safeStderr = failure.stderr
          ? scrubPaths(failure.stderr).slice(0, 4096)
          : null;
        return NextResponse.json(
          { error: `claude exited ${failure.code}`, stderr: safeStderr },
          { status: 502 },
        );
      }
      try {
        if (owningTask && (owningTask.checked || owningTask.section === SECTION_DONE)) {
          await updateTask(owningTask.id, { section: SECTION_DOING, checked: false });
        }
      } catch (err) {
        logWarn("chat", "re-open task on chat failed", { error: (err as Error)?.message ?? String(err) });
      }
      return ok({ sessionId });
    } catch (e) {
      return NextResponse.json(serverError(e, "sessions:message"), { status: 500 });
    }
  });

  if (result === null) {
    return NextResponse.json(
      { error: "message already in flight for this session" },
      { status: 409 },
    );
  }
  return result;
}
