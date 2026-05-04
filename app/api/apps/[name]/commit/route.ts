/**
 * Commit the working tree of an app (manual, user-triggered).
 *
 * Sibling of the per-run `/api/tasks/<id>/runs/<sid>/commit`
 * endpoint, but scoped to the app's live tree (not a worktree).
 * Powers the Commit button on the app detail page.
 *
 * Body: { message: string, push?: boolean }
 */
import { NextResponse, type NextRequest } from "next/server";
import { existsSync } from "node:fs";
import { DEFAULT_GIT_SETTINGS, resolveAppFromRouteSegment } from "@/libs/apps";
import { autoCommitAndPush } from "@/libs/gitOps";
import { badRequest } from "@/libs/validate";
import { safeErrorMessage } from "@/libs/errorResponse";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ name: string }> };

interface CommitBody {
  message: string;
  push?: boolean;
}

const MAX_MESSAGE_BYTES = 4 * 1024;

export async function POST(req: NextRequest, ctx: Ctx) {
  const { name: segment } = await ctx.params;

  let body: CommitBody;
  try {
    body = (await req.json()) as CommitBody;
  } catch {
    return badRequest("invalid JSON body");
  }
  const message = (body.message ?? "").trim();
  if (!message) return badRequest("commit message is required");
  if (message.length > MAX_MESSAGE_BYTES) {
    return badRequest(`message too long (max ${MAX_MESSAGE_BYTES} bytes)`);
  }
  const push = !!body.push;

  const app = resolveAppFromRouteSegment(segment);
  if (!app) return NextResponse.json({ error: "app not found" }, { status: 404 });
  const cwd = app.path;
  if (!existsSync(cwd)) {
    return NextResponse.json({ error: "app folder is missing", cwd }, { status: 404 });
  }

  try {
    const result = await autoCommitAndPush(
      cwd,
      // Honor the app's git policy (branch protection rules in
      // `tryPush`, etc.) but force-enable autoCommit and respect the
      // caller's push intent.
      {
        ...(app.git ?? DEFAULT_GIT_SETTINGS),
        autoCommit: true,
        autoPush: push,
      },
      message,
    );
    return NextResponse.json({ ...result, cwd });
  } catch (err) {
    return NextResponse.json(
      { error: "commit failed", detail: safeErrorMessage(err, "unknown") },
      { status: 500 },
    );
  }
}
