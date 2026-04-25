import { NextResponse, type NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolveRepoCwd } from "@/lib/repos";
import { BRIDGE_MD, BRIDGE_ROOT } from "@/lib/paths";
import { spawnFreeSession, waitEarlyFailure, type ChatSettings } from "@/lib/spawn";
import { freeSessionSettingsPath, writeSessionSettings } from "@/lib/permissionSettings";
import { isValidAppName } from "@/lib/apps";
import { badRequest, isValidPermissionMode } from "@/lib/validate";

export const dynamic = "force-dynamic";

interface CreateSessionBody {
  repo: string;
  prompt: string;
  settings?: ChatSettings;
}

/**
 * Hard caps on free-text body fields. The prompt is forwarded verbatim
 * to `claude` (which has its own limits), but capping at 50 KB here
 * keeps a hostile client from streaming gigabytes of JSON before we
 * realize there's no point — and matches the L2 audit recommendation.
 *
 * `repo` is also a string but the charset/length cap is enforced by
 * `isValidAppName` (≤ 64 chars, slug-only).
 */
const MAX_PROMPT_CHARS = 50_000;

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
 *
 * H2 hardening: every body field is now validated up-front so a caller
 * can't (a) inject a path-traversal `repo`, (b) coerce
 * `settings.mode = "bypassPermissions"` past a UI that didn't offer
 * the option, or (c) DoS the bridge with a multi-megabyte prompt.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json()) as Partial<CreateSessionBody>;

  // `repo`: must be a registered app slug. `isValidAppName` rejects
  // empty strings, traversal payloads, and anything outside the
  // `[A-Za-z0-9][A-Za-z0-9._-]*` charset, capped at 64 chars.
  if (!isValidAppName(body.repo)) return badRequest("invalid repo");

  // `prompt`: required, trimmed, capped. Treat the empty / whitespace-
  // only case as the existing 400 to avoid silently spawning an empty
  // session.
  if (typeof body.prompt !== "string" || !body.prompt.trim()) {
    return badRequest("prompt required");
  }
  if (body.prompt.length > MAX_PROMPT_CHARS) {
    return badRequest(`prompt too long (max ${MAX_PROMPT_CHARS} chars)`);
  }

  // `settings.mode`: optional, but if set must be one of the documented
  // permission modes. Without this check a caller could pass any
  // arbitrary string — including `bypassPermissions` — even when the
  // UI didn't expose that choice.
  if (
    body.settings !== undefined &&
    body.settings !== null &&
    typeof body.settings !== "object"
  ) {
    return badRequest("invalid settings");
  }
  if (
    body.settings?.mode !== undefined &&
    !isValidPermissionMode(body.settings.mode)
  ) {
    return badRequest("invalid settings.mode");
  }

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
