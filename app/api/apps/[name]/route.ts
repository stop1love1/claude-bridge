import { NextResponse } from "next/server";
import {
  getApp,
  isValidAppName,
  removeApp,
  renameApp,
  updateAppDescription,
  updateAppGitSettings,
  updateAppVerify,
  type AppGitSettings,
  type AppVerify,
  type GitBranchMode,
} from "@/lib/apps";
import { migrateTaskApp } from "@/lib/tasksStore";

export const dynamic = "force-dynamic";

const VALID_BRANCH_MODES: GitBranchMode[] = ["current", "fixed", "auto-create"];
// Restrict the fixed-branch input to git-friendly characters. Refs can't
// contain spaces, `..`, `~`, `^`, `:`, `?`, `*`, `[`, backslashes, or end
// in `.lock`; the regex below is conservative but covers the real-world
// cases (`main`, `develop`, `feature/x`, `release-1.2`).
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,200}$/;

interface PatchBody {
  name?: string;
  description?: string;
  git?: Partial<AppGitSettings>;
  verify?: Partial<AppVerify>;
}

const VERIFY_KEYS: Array<keyof AppVerify> = [
  "test", "lint", "build", "typecheck", "format",
];
// Verify commands run via `sh -c <cmd>` in P2; cap length to a sane
// shell-line bound so a runaway paste can't blow up later exec calls.
const VERIFY_CMD_MAX = 1024;

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ name: string }> },
) {
  const { name } = await ctx.params;
  if (!isValidAppName(name)) {
    return NextResponse.json({ error: "invalid app name" }, { status: 400 });
  }
  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const hasName = typeof body.name === "string";
  const hasDescription = typeof body.description === "string";
  const gitPatch = body.git;
  const hasGit = !!gitPatch && typeof gitPatch === "object";
  const verifyPatch = body.verify;
  const hasVerify = !!verifyPatch && typeof verifyPatch === "object";
  if (!hasName && !hasDescription && !hasGit && !hasVerify) {
    return NextResponse.json(
      { error: "patch is empty (expected name, description, git, or verify)" },
      { status: 400 },
    );
  }
  if (hasGit) {
    const gp = gitPatch as Partial<AppGitSettings>;
    if (gp.branchMode !== undefined && !VALID_BRANCH_MODES.includes(gp.branchMode)) {
      return NextResponse.json(
        { error: `invalid branchMode: "${gp.branchMode}"` },
        { status: 400 },
      );
    }
    if (gp.branchMode === "fixed") {
      const branch = (gp.fixedBranch ?? "").trim();
      if (!branch) {
        return NextResponse.json({ error: "fixedBranch is required for branchMode=fixed" }, { status: 400 });
      }
      if (!BRANCH_RE.test(branch)) {
        return NextResponse.json({ error: "fixedBranch contains invalid characters" }, { status: 400 });
      }
      gp.fixedBranch = branch;
    }
  }

  // Confirm the app actually exists before any side effects so we don't
  // half-apply a patch (e.g. rewrite description, then 404 on the rename).
  if (!getApp(name)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  let currentName = name;
  let migratedTasks = 0;

  // Order matters: rename FIRST so subsequent description/git updates
  // address the new name. Migrate task metadata in the same step so the
  // UI never sees a window where tasks point at a non-existent app.
  if (hasName) {
    const desired = (body.name ?? "").trim();
    if (!isValidAppName(desired)) {
      return NextResponse.json(
        {
          error: "invalid new name (allowed: letters, digits, dot, dash, underscore; must start with alphanumeric)",
        },
        { status: 400 },
      );
    }
    if (desired !== currentName) {
      const r = renameApp(currentName, desired);
      if (!r.ok) {
        const status = r.reason === "duplicate-name" ? 409 : r.reason === "not-found" ? 404 : 400;
        return NextResponse.json({ error: r.reason }, { status });
      }
      migratedTasks = migrateTaskApp(currentName, desired);
      currentName = desired;
    }
  }

  if (hasDescription) {
    const next = (body.description ?? "").trim();
    const updated = updateAppDescription(currentName, next);
    if (!updated) return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  if (hasGit) {
    const updated = updateAppGitSettings(currentName, gitPatch as Partial<AppGitSettings>);
    if (!updated) return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  if (hasVerify) {
    const vp = verifyPatch as Partial<AppVerify>;
    // Validate every supplied verify command up-front: shell strings (or
    // empty string to clear). Reject unknown keys / non-strings so a bad
    // patch never lands in bridge.json.
    const sanitized: Partial<AppVerify> = {};
    for (const key of VERIFY_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(vp, key)) continue;
      const v = vp[key];
      if (v === "" || v === null) {
        sanitized[key] = "";
        continue;
      }
      if (typeof v !== "string") {
        return NextResponse.json(
          { error: `verify.${key} must be a string (or "" to clear)` },
          { status: 400 },
        );
      }
      const trimmed = v.trim();
      if (trimmed.length > VERIFY_CMD_MAX) {
        return NextResponse.json(
          { error: `verify.${key} exceeds ${VERIFY_CMD_MAX} chars` },
          { status: 400 },
        );
      }
      sanitized[key] = trimmed;
    }
    const updated = updateAppVerify(currentName, sanitized);
    if (!updated) return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const finalApp = getApp(currentName);
  if (!finalApp) return NextResponse.json({ error: "not found after patch" }, { status: 500 });
  return NextResponse.json({ ...finalApp, migratedTasks });
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ name: string }> },
) {
  const { name } = await ctx.params;
  if (!isValidAppName(name)) {
    return NextResponse.json({ error: "invalid app name" }, { status: 400 });
  }
  const ok = removeApp(name);
  if (!ok) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
