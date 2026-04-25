import { NextResponse, type NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolveRepoCwd } from "@/lib/repos";
import { BRIDGE_MD, BRIDGE_ROOT } from "@/lib/paths";
import { spawnFreeSession, waitEarlyFailure, type ChatSettings } from "@/lib/spawn";
import { freeSessionSettingsPath, writeSessionSettings } from "@/lib/permissionSettings";

export const dynamic = "force-dynamic";

interface CreateSessionBody {
  repo: string;
  prompt: string;
  settings?: ChatSettings;
}

/**
 * Spawn a brand-new Claude session in the chosen repo, with an initial
 * prompt. The session is "orphan" until the user links it to a task.
 *
 * Body: { repo: string, prompt: string, settings?: ChatSettings }
 *
 * Permission default is `bypassPermissions` — every tool call runs
 * without asking. Set `settings.mode = "default"` explicitly in the
 * body to opt back into the per-tool Allow/Deny popup (we register
 * the PreToolUse hook only in that case).
 */
export async function POST(req: NextRequest) {
  const body = (await req.json()) as Partial<CreateSessionBody>;
  if (!body.repo) return NextResponse.json({ error: "repo required" }, { status: 400 });
  if (!body.prompt?.trim()) return NextResponse.json({ error: "prompt required" }, { status: 400 });

  const md = readFileSync(BRIDGE_MD, "utf8");
  const cwd = resolveRepoCwd(md, BRIDGE_ROOT, body.repo);
  if (!cwd) return NextResponse.json({ error: `unknown repo: ${body.repo}` }, { status: 400 });

  try {
    const sessionId = randomUUID();
    const wantsPopup = body.settings?.mode === "default";
    const effectiveSettings: ChatSettings = wantsPopup
      ? body.settings!
      : { ...(body.settings ?? {}), mode: "bypassPermissions" };
    const settingsPath = wantsPopup
      ? writeSessionSettings(freeSessionSettingsPath(sessionId))
      : undefined;
    const { child } = spawnFreeSession(cwd, body.prompt.trim(), effectiveSettings, settingsPath, sessionId);
    const failure = await waitEarlyFailure(child, 1500);
    if (failure) {
      return NextResponse.json(
        { error: `claude exited ${failure.code}`, stderr: failure.stderr || null },
        { status: 502 },
      );
    }
    return NextResponse.json({ sessionId, repo: body.repo, cwd }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
