import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { resolveRepoCwd } from "@/libs/repos";
import { BRIDGE_ROOT, readBridgeMd } from "@/libs/paths";
import { spawnFreeSession, waitEarlyFailure, type ChatSettings } from "@/libs/spawn";
import { freeSessionSettingsPath, writeSessionSettings } from "@/libs/permissionSettings";
import { isValidAppName } from "@/libs/apps";
import { badRequest, isValidUserPermissionMode } from "@/libs/validate";
import { serverError } from "@/libs/errorResponse";

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
 * Permission default is `default` — every tool call triggers the
 * Allow/Deny popup. The composer's mode picker only exposes
 * non-privileged modes (`default` / `acceptEdits` / `plan` / `auto`),
 * matching `isValidUserPermissionMode`. Bypass mode stays reachable
 * for server-side callers (coordinator / agents) that construct
 * ChatSettings directly inside an internal-token-gated handler.
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
  // Loose `!=` rejects both `undefined` and `null` in one shot, so the
  // remaining check is just "must be a real object literal".
  if (body.settings != null && typeof body.settings !== "object") {
    return badRequest("invalid settings");
  }
  if (
    body.settings?.mode !== undefined &&
    !isValidUserPermissionMode(body.settings.mode)
  ) {
    return badRequest("invalid settings.mode");
  }

  const md = readBridgeMd();
  const cwd = resolveRepoCwd(md, BRIDGE_ROOT, body.repo);
  // L4: keep the rejected name out of the response body — the caller
  // already knows what they sent.
  if (!cwd) return NextResponse.json({ error: "unknown repo" }, { status: 400 });

  try {
    const sessionId = randomUUID();
    // Default to the popup-driven `default` mode. The body cannot
    // request `bypassPermissions` because `isValidUserPermissionMode`
    // rejects it above.
    const effectiveSettings: ChatSettings = {
      ...(body.settings ?? {}),
      mode: body.settings?.mode ?? "default",
    };
    const settingsPath = writeSessionSettings(freeSessionSettingsPath(sessionId));
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
    return NextResponse.json(serverError(e, "sessions:create"), { status: 500 });
  }
}
