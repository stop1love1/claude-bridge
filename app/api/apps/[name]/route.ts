import { NextResponse } from "next/server";
import {
  getApp,
  isValidAppName,
  removeApp,
  renameApp,
  updateAppDescription,
  updateAppGitSettings,
  updateAppQuality,
  updateAppRetry,
  updateAppVerify,
  type AppGitSettings,
  type AppQuality,
  type AppRetry,
  type AppVerify,
  type GitBranchMode,
  type GitIntegrationMode,
} from "@/libs/apps";
import { migrateTaskApp } from "@/libs/tasksStore";
import { MAX_RETRY_PER_GATE } from "@/libs/retryLadder";

export const dynamic = "force-dynamic";

const VALID_BRANCH_MODES: GitBranchMode[] = ["current", "fixed", "auto-create"];
const VALID_WORKTREE_MODES: ("disabled" | "enabled")[] = ["disabled", "enabled"];
const VALID_INTEGRATION_MODES: GitIntegrationMode[] = ["none", "auto-merge", "pull-request"];
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
  quality?: Partial<AppQuality>;
  retry?: Partial<Record<keyof AppRetry, number | null>>;
}

const QUALITY_KEYS: Array<keyof AppQuality> = ["critic", "verifier"];

const RETRY_KEYS: Array<keyof AppRetry> = [
  "crash", "verify", "claim", "preflight", "style", "semantic",
];

const VERIFY_KEYS: Array<keyof AppVerify> = [
  "test", "lint", "build", "typecheck", "format",
];
// Verify commands run via `sh -c <cmd>` in P2; cap length to a sane
// shell-line bound so a runaway paste can't blow up later exec calls.
const VERIFY_CMD_MAX = 1024;

/**
 * When the deployment opts into `BRIDGE_LOCK_VERIFY=1`, every
 * verify-command edit through the API is rejected. The operator can
 * still seed verify commands at deploy time by editing
 * `~/.claude/bridge.json` directly (file is mode 0600, only the
 * deploying user can write it). This locks the post-auth RCE surface
 * — a hijacked browser cookie can no longer rewrite shell strings the
 * verify chain will execute.
 *
 * Defaults to OFF so existing local-only installs keep their UX. The
 * production deployment guide should set this to "1".
 */
const VERIFY_LOCKED = process.env.BRIDGE_LOCK_VERIFY === "1";

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
  if (hasVerify && VERIFY_LOCKED) {
    return NextResponse.json(
      {
        error: "verify edits are locked",
        hint: "BRIDGE_LOCK_VERIFY=1 — edit `~/.claude/bridge.json` on the host to change verify commands",
      },
      { status: 403 },
    );
  }
  const qualityPatch = body.quality;
  const hasQuality = !!qualityPatch && typeof qualityPatch === "object";
  const retryPatch = body.retry;
  const hasRetry = !!retryPatch && typeof retryPatch === "object";
  if (!hasName && !hasDescription && !hasGit && !hasVerify && !hasQuality && !hasRetry) {
    return NextResponse.json(
      { error: "patch is empty (expected name, description, git, verify, quality, or retry)" },
      { status: 400 },
    );
  }
  // Confirm the app exists before any validation so a missing app surfaces
  // as 404 rather than a misleading 400 from a cross-field rule that
  // happened to inspect the (null) existing record.
  const existingApp = getApp(name);
  if (!existingApp) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
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
    if (gp.worktreeMode !== undefined && !VALID_WORKTREE_MODES.includes(gp.worktreeMode)) {
      return NextResponse.json(
        { error: `invalid worktreeMode: "${gp.worktreeMode}"` },
        { status: 400 },
      );
    }
    if (gp.mergeTargetBranch !== undefined) {
      if (typeof gp.mergeTargetBranch !== "string") {
        return NextResponse.json(
          { error: "mergeTargetBranch must be a string (or '' to clear)" },
          { status: 400 },
        );
      }
      const target = gp.mergeTargetBranch.trim();
      if (target.length > 0 && !BRANCH_RE.test(target)) {
        return NextResponse.json(
          { error: "mergeTargetBranch contains invalid characters" },
          { status: 400 },
        );
      }
      gp.mergeTargetBranch = target;
    }
    if (gp.integrationMode !== undefined && !VALID_INTEGRATION_MODES.includes(gp.integrationMode)) {
      return NextResponse.json(
        { error: `invalid integrationMode: "${gp.integrationMode}"` },
        { status: 400 },
      );
    }
    // Cross-field rule: a non-`none` integrationMode requires a target.
    // We check both the patch's own target (if supplied) and the existing
    // value (if the patch only updates mode without touching target).
    if (
      gp.integrationMode !== undefined &&
      gp.integrationMode !== "none"
    ) {
      const patchTarget =
        typeof gp.mergeTargetBranch === "string" ? gp.mergeTargetBranch.trim() : undefined;
      const existingTarget = existingApp.git.mergeTargetBranch.trim();
      const effective = patchTarget !== undefined ? patchTarget : existingTarget;
      if (!effective) {
        return NextResponse.json(
          { error: `integrationMode=${gp.integrationMode} requires mergeTargetBranch` },
          { status: 400 },
        );
      }
    }
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
      migratedTasks = await migrateTaskApp(currentName, desired);
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

  if (hasQuality) {
    const qp = qualityPatch as Partial<AppQuality>;
    const sanitized: Partial<AppQuality> = {};
    for (const key of QUALITY_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(qp, key)) continue;
      const v = qp[key];
      if (typeof v !== "boolean") {
        return NextResponse.json(
          { error: `quality.${key} must be a boolean` },
          { status: 400 },
        );
      }
      sanitized[key] = v;
    }
    const updated = updateAppQuality(currentName, sanitized);
    if (!updated) return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  if (hasRetry) {
    const rp = retryPatch as Partial<Record<keyof AppRetry, number | null>>;
    const sanitized: Partial<Record<keyof AppRetry, number | null>> = {};
    for (const key of RETRY_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(rp, key)) continue;
      const v = rp[key];
      if (v === null) {
        sanitized[key] = null;
        continue;
      }
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > MAX_RETRY_PER_GATE) {
        return NextResponse.json(
          { error: `retry.${key} must be an integer in [0, ${MAX_RETRY_PER_GATE}] (or null to clear)` },
          { status: 400 },
        );
      }
      sanitized[key] = Math.floor(v);
    }
    const updated = updateAppRetry(currentName, sanitized);
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
