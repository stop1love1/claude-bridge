import { NextResponse, type NextRequest } from "next/server";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveRepoCwd } from "@/libs/repos";
import { BRIDGE_ROOT, SESSIONS_DIR, readBridgeMd } from "@/libs/paths";
import { spawnFreeSession, waitEarlyFailure, type ChatSettings } from "@/libs/spawn";
import { resumeSessionWithLifecycle } from "@/libs/resumeSession";
import { projectDirFor } from "@/libs/sessions";
import { freeSessionSettingsPath, writeSessionSettings } from "@/libs/permissionSettings";
import { badRequest, isValidEffort, isValidSessionId, isValidUserPermissionMode } from "@/libs/validate";
import { findTaskBySessionId, updateTask } from "@/libs/tasksStore";
import { SECTION_DOING, SECTION_DONE } from "@/libs/tasks";
import { isValidAppName } from "@/libs/apps";
import { verifyRequestActor } from "@/libs/auth";
import { readMeta } from "@/libs/meta";
import { guestBoundRepoValue } from "@/libs/guestSessionRepo";
import { scrubPaths, serverError } from "@/libs/errorResponse";
import { ok } from "@/libs/apiResponse";
import { isAlive } from "@/libs/sessionEvents";
import {
  dequeueMessage,
  enqueueMessage,
  queueLength,
  type QueuedMessage,
} from "@/libs/messageQueue";
import { logError, logInfo } from "@/libs/log";

function attachQueueDrain(child: ChildProcess, sessionId: string): void {
  child.once("exit", () => {
    const next = dequeueMessage(sessionId);
    if (!next) return;
    try {
      const drained = resumeSessionWithLifecycle({
        cwd: next.cwd,
        sessionId,
        message: next.message,
        settings: next.settings,
        settingsPath: next.settingsPath,
        context: next.context ?? `chat-queued ${sessionId.slice(0, 8)}`,
      });
      attachQueueDrain(drained, sessionId);
      logInfo(
        "msg-queue",
        `drained queued message for ${sessionId.slice(0, 8)} (${queueLength(sessionId)} still pending)`,
      );
    } catch (e) {
      logError("msg-queue", "drain spawn failed", e, {
        sessionId: sessionId.slice(0, 8),
      });
    }
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

  try {
    const fallbackMode =
      process.env.NEXT_PUBLIC_BRIDGE_ALLOW_BYPASS === "1" ? "bypassPermissions" : "default";
    const effectiveSettings: ChatSettings = {
      ...(settings ?? {}),
      mode: settings?.mode ?? fallbackMode,
    };
    const settingsPath = writeSessionSettings(freeSessionSettingsPath(sessionId));
    const file = join(projectDirFor(cwd), `${sessionId}.jsonl`);

    if (existsSync(file) && isAlive(sessionId)) {
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

    const child = existsSync(file)
      ? resumeSessionWithLifecycle({
          cwd,
          sessionId,
          message,
          settings: effectiveSettings,
          settingsPath,
          context: `chat-resume ${sessionId.slice(0, 8)}`,
        })
      : spawnFreeSession(cwd, message, effectiveSettings, settingsPath, sessionId).child;

    attachQueueDrain(child, sessionId);

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
      const owningTask = findTaskBySessionId(sessionId);
      if (owningTask && (owningTask.checked || owningTask.section === SECTION_DONE)) {
        await updateTask(owningTask.id, { section: SECTION_DOING, checked: false });
      }
    } catch (err) {
      console.warn("re-open task on chat failed", err);
    }
    return ok({ sessionId });
  } catch (e) {
    return NextResponse.json(serverError(e, "sessions:message"), { status: 500 });
  }
}
