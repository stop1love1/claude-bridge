import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { resolveRepoCwd } from "@/libs/repos";
import { BRIDGE_ROOT, readBridgeMd } from "@/libs/paths";
import { spawnFreeSession, waitEarlyFailure, type ChatSettings } from "@/libs/spawn";
import { freeSessionSettingsPath, writeSessionSettings } from "@/libs/permissionSettings";
import { isValidAppName } from "@/libs/apps";
import { badRequest, isValidUserPermissionMode } from "@/libs/validate";
import { scrubPaths, serverError } from "@/libs/errorResponse";

export const dynamic = "force-dynamic";

interface CreateSessionBody {
  repo: string;
  prompt: string;
  settings?: ChatSettings;
}

const MAX_PROMPT_CHARS = 50_000;

export async function POST(req: NextRequest) {
  const body = (await req.json()) as Partial<CreateSessionBody>;

  if (!isValidAppName(body.repo)) return badRequest("invalid repo");

  if (typeof body.prompt !== "string" || !body.prompt.trim()) {
    return badRequest("prompt required");
  }
  if (body.prompt.length > MAX_PROMPT_CHARS) {
    return badRequest(`prompt too long (max ${MAX_PROMPT_CHARS} chars)`);
  }

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
  if (!cwd) return NextResponse.json({ error: "unknown repo" }, { status: 400 });

  try {
    const sessionId = randomUUID();
    const effectiveSettings: ChatSettings = {
      ...(body.settings ?? {}),
      mode: body.settings?.mode ?? "default",
    };
    const settingsPath = writeSessionSettings(freeSessionSettingsPath(sessionId));
    const { child } = spawnFreeSession(cwd, body.prompt.trim(), effectiveSettings, settingsPath, sessionId);
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
    return NextResponse.json({ sessionId, repo: body.repo, cwd }, { status: 201 });
  } catch (e) {
    return NextResponse.json(serverError(e, "sessions:create"), { status: 500 });
  }
}
