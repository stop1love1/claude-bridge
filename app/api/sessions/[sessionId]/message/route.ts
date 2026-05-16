import { NextResponse, type NextRequest } from "next/server";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveRepoCwd } from "@/libs/repos";
import { BRIDGE_ROOT, readBridgeMd } from "@/libs/paths";
import { spawnFreeSession, waitEarlyFailure, type ChatSettings } from "@/libs/spawn";
import { resumeSessionWithLifecycle } from "@/libs/resumeSession";
import { projectDirFor } from "@/libs/sessions";
import { freeSessionSettingsPath, writeSessionSettings } from "@/libs/permissionSettings";
import { badRequest, isValidSessionId, isValidUserPermissionMode } from "@/libs/validate";
import { findTaskBySessionId, updateTask } from "@/libs/tasksStore";
import { SECTION_DOING, SECTION_DONE } from "@/libs/tasks";
import { isValidAppName } from "@/libs/apps";
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

/**
 * Attach a one-shot exit listener that drains the next queued message
 * (if any) by re-entering `resumeSessionWithLifecycle`. Recursive: the
 * spawned child also gets a drain hook so a queue of N messages
 * cleanly walks itself empty without per-step user action.
 *
 * Lives outside the request handler because it must outlive the HTTP
 * response — the child is held by the spawnRegistry and survives long
 * after we return 200 to the browser.
 */
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
      // Chain the next drain — keeps the FIFO walking until empty.
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

/**
 * Send a user message into an existing Claude Code session. Works like
 * typing another turn in `claude` CLI — the .jsonl gets extended and
 * the UI's tail picks up the reply.
 *
 * Body: { message: string, repo: string, settings?: ChatSettings }
 *   - repo: folder name of the repo that owns this session (one of the
 *     entries in BRIDGE.md, or the bridge folder itself); used as cwd
 *     so --resume finds the session.
 *   - settings: optional per-turn overrides for permission-mode / effort
 *     / model, mirroring the picker shown in the composer.
 *
 * Permission default is `default` — tool calls trigger the per-tool
 * Allow/Deny popup. The composer's mode picker only exposes safe
 * options (`default` / `acceptEdits` / `plan` / `auto`), so this
 * matches the UI label "Ask before edits". Callers that genuinely
 * want headless / bypass mode (coordinator children, scripted task
 * continuation) construct ChatSettings with `mode: "bypassPermissions"`
 * explicitly — the relevant routes are gated by the internal token.
 */
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

  const md = readBridgeMd();
  const cwd = resolveRepoCwd(md, BRIDGE_ROOT, repo!);
  // L4: don't echo the rejected `repo` value back. A 400 reply is
  // enough — including the input string makes log-poisoning easier
  // and offers nothing useful to a legitimate caller.
  if (!cwd) return NextResponse.json({ error: "unknown repo" }, { status: 400 });

  try {
    // The user-facing mode picker only ever sends one of
    // {default, acceptEdits, plan, auto, bypassPermissions}. We default
    // to `default` (the permission popup) when the body omitted `mode`,
    // so opening the composer and hitting Enter behaves the way the
    // dropdown label ("Ask before edits") promises. Bypass mode is
    // reachable from this endpoint only when the operator explicitly
    // opted into it via `NEXT_PUBLIC_BRIDGE_ALLOW_BYPASS=1` — in which
    // case the missing-mode fallback flips to bypass too, matching the
    // single-user UX promise the env var advertises. The validation
    // check above already gates the explicit value the same way.
    const fallbackMode =
      process.env.NEXT_PUBLIC_BRIDGE_ALLOW_BYPASS === "1" ? "bypassPermissions" : "default";
    const effectiveSettings: ChatSettings = {
      ...(settings ?? {}),
      mode: settings?.mode ?? fallbackMode,
    };
    const settingsPath = writeSessionSettings(freeSessionSettingsPath(sessionId));
    // "Create-on-first-send": when the UI generates a UUID locally (no
    // up-front spawn), the .jsonl doesn't exist yet on the first message.
    // Treat that as a fresh session start instead of a resume — same
    // session id, but `claude --session-id <uuid>` initialises the file.
    const file = join(projectDirFor(cwd), `${sessionId}.jsonl`);

    // ─── Queue path ────────────────────────────────────────────────
    // If a claude process is currently alive for this sessionId, a
    // second `--resume` would race the first — both write to the same
    // .jsonl, the in-flight turn ends with a stop_sequence cut-off,
    // and the user's previous request is silently dropped. Queue the
    // payload instead; the active child's exit hook (attached below)
    // will drain it via resumeSessionWithLifecycle. Free chats and
    // tasks both go through this path — `isAlive` is the source of
    // truth for "process exists right now".
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

    // ─── Spawn path ────────────────────────────────────────────────
    // resumeSessionWithLifecycle flips the owning task's run row
    // done|failed → running and wires the new process's exit; for free
    // chats with no owning task it falls through to a plain resumeClaude.
    // The task re-open block further down (DONE → DOING) covers section
    // state, but the run-row badge fix is what this helper buys us.
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

    // Drain hook lives on the spawned child — when it exits, the next
    // queued message (if any) re-enters resumeSessionWithLifecycle.
    // Idempotent: nothing happens when the queue is empty at exit time.
    attachQueueDrain(child, sessionId);

    // Wait briefly so we can surface "binary not found / bad args /
    // immediate crash" cases as a real error instead of a silent 200.
    // A healthy `claude -p --resume` runs for many seconds, so a 1.5s
    // window is more than enough to catch the fail-fast cases without
    // delaying normal sends.
    const failure = await waitEarlyFailure(child, 1500);
    if (failure) {
      // Scrub absolute paths + cap to keep the response body bounded.
      const safeStderr = failure.stderr
        ? scrubPaths(failure.stderr).slice(0, 4096)
        : null;
      return NextResponse.json(
        { error: `claude exited ${failure.code}`, stderr: safeStderr },
        { status: 502 },
      );
    }
    // Re-open a task that the user previously ticked done. The user's
    // intent is clear: another message means there's more work to do,
    // so the "DONE — not yet archived" pill would be lying. Flip back
    // to DOING and untick. Best-effort: a failure here mustn't block
    // the message itself (the spawn already succeeded).
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
