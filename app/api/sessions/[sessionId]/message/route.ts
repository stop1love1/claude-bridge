import { NextResponse, type NextRequest } from "next/server";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveRepoCwd } from "@/lib/repos";
import { BRIDGE_ROOT, readBridgeMd } from "@/lib/paths";
import { resumeClaude, spawnFreeSession, waitEarlyFailure, type ChatSettings } from "@/lib/spawn";
import { projectDirFor } from "@/lib/sessions";
import { freeSessionSettingsPath, writeSessionSettings } from "@/lib/permissionSettings";
import { badRequest, isValidSessionId, isValidUserPermissionMode } from "@/lib/validate";
import { findTaskBySessionId, updateTask } from "@/lib/tasksStore";
import { isValidAppName } from "@/lib/apps";

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
    // {default, acceptEdits, plan, auto}. We default to `default` (the
    // permission popup) when the body omitted `mode`, so opening the
    // composer and hitting Enter behaves the way the dropdown label
    // ("Ask before edits") promises. Bypass mode is reachable only via
    // the internal-token-gated agent / continuation routes — never
    // from this endpoint.
    const effectiveSettings: ChatSettings = {
      ...(settings ?? {}),
      mode: settings?.mode ?? "default",
    };
    const settingsPath = writeSessionSettings(freeSessionSettingsPath(sessionId));
    // "Create-on-first-send": when the UI generates a UUID locally (no
    // up-front spawn), the .jsonl doesn't exist yet on the first message.
    // Treat that as a fresh session start instead of a resume — same
    // session id, but `claude --session-id <uuid>` initialises the file.
    const file = join(projectDirFor(cwd), `${sessionId}.jsonl`);
    const child = existsSync(file)
      ? resumeClaude(cwd, sessionId, message, effectiveSettings, settingsPath)
      : spawnFreeSession(cwd, message, effectiveSettings, settingsPath, sessionId).child;
    // Wait briefly so we can surface "binary not found / bad args /
    // immediate crash" cases as a real error instead of a silent 200.
    // A healthy `claude -p --resume` runs for many seconds, so a 1.5s
    // window is more than enough to catch the fail-fast cases without
    // delaying normal sends.
    const failure = await waitEarlyFailure(child, 1500);
    if (failure) {
      return NextResponse.json(
        { error: `claude exited ${failure.code}`, stderr: failure.stderr || null },
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
      if (owningTask && (owningTask.checked || owningTask.section === "DONE — not yet archived")) {
        await updateTask(owningTask.id, { section: "DOING", checked: false });
      }
    } catch (err) {
      console.warn("re-open task on chat failed", err);
    }
    return NextResponse.json({ ok: true, sessionId });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
