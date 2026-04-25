import { NextResponse, type NextRequest } from "next/server";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveRepoCwd } from "@/lib/repos";
import { BRIDGE_MD, BRIDGE_ROOT } from "@/lib/paths";
import { resumeClaude, spawnFreeSession, waitEarlyFailure, type ChatSettings } from "@/lib/spawn";
import { projectDirFor } from "@/lib/sessions";
import { freeSessionSettingsPath, writeSessionSettings } from "@/lib/permissionSettings";

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
 * Permission default is `bypassPermissions` — tool calls run without
 * asking the user. Pass `settings.mode = "default"` explicitly to
 * re-enable the per-tool Allow/Deny popup; we attach the PreToolUse
 * hook via `--settings` only in that case.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { sessionId } = await ctx.params;
  const body = (await req.json()) as { message?: string; repo?: string; settings?: ChatSettings };
  const { message, repo, settings } = body;
  if (!message?.trim()) return NextResponse.json({ error: "message required" }, { status: 400 });
  if (!repo)           return NextResponse.json({ error: "repo required" },    { status: 400 });

  const md = readFileSync(BRIDGE_MD, "utf8");
  const cwd = resolveRepoCwd(md, BRIDGE_ROOT, repo);
  if (!cwd) return NextResponse.json({ error: `unknown repo: ${repo}` }, { status: 400 });

  try {
    const wantsPopup = settings?.mode === "default";
    const effectiveSettings: ChatSettings = wantsPopup
      ? settings!
      : { ...(settings ?? {}), mode: "bypassPermissions" };
    const settingsPath = wantsPopup
      ? writeSessionSettings(freeSessionSettingsPath(sessionId))
      : undefined;
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
    return NextResponse.json({ ok: true, sessionId });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
