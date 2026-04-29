/**
 * DevOps integration — spawned when an app's
 * `git.integrationMode === "pull-request"`. The agent uses the local
 * `gh` (GitHub) or `glab` (GitLab) CLI to open a PR/MR against the
 * operator's `mergeTargetBranch`.
 *
 * Distinct from the local auto-merge path (`mergeIntoTargetBranch`):
 * auto-merge lands code directly on the target branch in the local
 * tree; the devops path leaves the work branch on the remote and asks
 * the host's review system to manage the merge.
 *
 * Eligibility (server-side, before spawning):
 *
 *   1. Repo is a git repo with an `origin` remote.
 *   2. The matching CLI is installed (`gh --version` / `glab --version`).
 *   3. The work branch was pushed to origin (autoPush succeeded, or the
 *      operator pushed manually). The agent re-pushes defensively
 *      regardless — `git push` is idempotent.
 *
 * Any failure short-circuits to a `skipped` outcome with a logged
 * reason. We never block the run on PR creation — the work branch is
 * already shipped, the operator can open the PR by hand if needed.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Run } from "./meta";
import { runAgentGate, type AgentGateOutcome } from "./qualityGate";

const execFileP = promisify(execFile);

export const DEVOPS_ROLE = "devops";
const VERDICT_FILE = "devops-verdict.json";
const PROBE_TIMEOUT_MS = 5_000;
const GIT_TIMEOUT_MS = 5_000;

export type IntegrationCli = "gh" | "glab";
export type IntegrationHost = "github" | "gitlab" | "unknown";

export interface IntegrationContext {
  cli: IntegrationCli;
  host: IntegrationHost;
  /** Origin remote URL as `git remote get-url origin` returned it. */
  remote: string;
}

export interface DetectionMiss {
  reason: string;
}

export interface DevopsVerdict {
  status: "opened" | "exists" | "skipped";
  url: string | null;
  cli: IntegrationCli;
  reason: string;
}

/**
 * Probe whether a CLI binary is installed + invokable in the current
 * environment. Avoids `which` (Windows-unfriendly); just calls
 * `<cli> --version` with a short timeout. Any non-zero exit / spawn
 * failure → not available.
 */
async function isCliInstalled(cli: IntegrationCli): Promise<boolean> {
  try {
    await execFileP(cli, ["--version"], {
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse the host out of a git remote URL. Handles both ssh
 * (`git@github.com:owner/repo.git`) and https
 * (`https://github.com/owner/repo.git`) forms.
 *
 * Returns `null` if the URL doesn't match either shape.
 */
export function parseRemoteHost(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  // ssh: user@host:path
  const ssh = /^[^@\s]+@([^:\s]+):/.exec(trimmed);
  if (ssh) return ssh[1].toLowerCase();
  // https / git protocol: scheme://host/path
  try {
    const u = new URL(trimmed);
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Map a hostname to the host family + preferred CLI. Explicit host
 * matches take precedence. Self-hosted instances (`gh.company.com`,
 * `git.acme.io`) fall through to `unknown`, in which case the caller
 * decides via fallback (try whichever CLI is installed).
 *
 * The gitlab branch only matches `gitlab.com` plus hostnames where
 * `gitlab` is a full label (subdomain like `gitlab.acme.io` or suffix
 * like `internal.gitlab.acme.io`). A naive `includes("gitlab")` would
 * misroute hosts like `notgitlab.internal` or `gitlab-archive.com` to
 * the gitlab CLI, then fail when the protocol disagrees.
 */
export function classifyHost(host: string): IntegrationHost {
  const h = host.toLowerCase();
  if (h === "github.com" || h.endsWith(".github.com")) return "github";
  if (h === "gitlab.com" || /(?:^|\.)gitlab\./.test(h)) return "gitlab";
  return "unknown";
}

/**
 * Decide which CLI + host the devops agent should use for this repo.
 * Returns `null` (with a reason) if no usable combination exists.
 *
 * Selection ladder:
 *   1. If `git remote get-url origin` succeeds AND we can classify the
 *      host (github/gitlab), require the matching CLI installed.
 *   2. If the host is self-hosted (unknown), fall back to whichever CLI
 *      is installed locally — gh first, then glab.
 *   3. If the remote can't be classified and neither CLI is installed,
 *      surface that as the reason.
 */
export async function detectIntegrationCli(
  cwd: string,
): Promise<IntegrationContext | DetectionMiss> {
  let remoteUrl = "";
  try {
    const r = await execFileP("git", ["remote", "get-url", "origin"], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    });
    remoteUrl = r.stdout.toString().trim();
  } catch {
    return { reason: "no `origin` remote configured (run `git remote add origin <url>` first)" };
  }
  if (!remoteUrl) {
    return { reason: "`git remote get-url origin` returned an empty URL" };
  }

  const host = parseRemoteHost(remoteUrl);
  if (!host) {
    return { reason: `unrecognized remote URL shape: ${remoteUrl}` };
  }
  const family = classifyHost(host);

  if (family === "github") {
    if (!(await isCliInstalled("gh"))) {
      return { reason: `remote is github (${host}) but \`gh\` CLI is not installed` };
    }
    return { cli: "gh", host: "github", remote: remoteUrl };
  }
  if (family === "gitlab") {
    if (!(await isCliInstalled("glab"))) {
      return { reason: `remote is gitlab (${host}) but \`glab\` CLI is not installed` };
    }
    return { cli: "glab", host: "gitlab", remote: remoteUrl };
  }
  // Unknown host (self-hosted) — try whichever CLI exists, gh first.
  if (await isCliInstalled("gh")) {
    return { cli: "gh", host: "unknown", remote: remoteUrl };
  }
  if (await isCliInstalled("glab")) {
    return { cli: "glab", host: "unknown", remote: remoteUrl };
  }
  return {
    reason: `remote host \`${host}\` is self-hosted and neither \`gh\` nor \`glab\` is installed`,
  };
}

/**
 * Validate + coerce the agent-supplied JSON. Defensive against an LLM
 * that wrote an extra field or hallucinated a status outside the enum.
 * Returns `null` when the payload is unusable; callers map that to a
 * `skipped` outcome.
 */
export function parseDevopsVerdict(raw: unknown): DevopsVerdict | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const s = r.status;
  if (s !== "opened" && s !== "exists" && s !== "skipped") return null;

  const cli = r.cli;
  if (cli !== "gh" && cli !== "glab") return null;

  const url =
    typeof r.url === "string" && r.url.trim().length > 0
      ? r.url.trim().slice(0, 400)
      : null;

  const reason =
    typeof r.reason === "string" && r.reason.trim().length > 0
      ? r.reason.trim().slice(0, 400)
      : "(no reason provided)";

  return { status: s, url, cli, reason };
}

export interface RunDevopsOptions {
  appPath: string;
  taskId: string;
  finishedRun: Run;
  taskTitle: string;
  taskBody: string;
  /** The work branch to use as the PR/MR head. */
  sourceBranch: string;
  /** The integration target branch (operator's `mergeTargetBranch`). */
  targetBranch: string;
}

export interface DevopsOutcome {
  status: DevopsVerdict["status"] | "missing-cli" | "no-remote";
  url: string | null;
  reason: string;
  /** Session id of the spawned devops child, if we got that far. */
  devopsSessionId: string | null;
  durationMs: number;
}

/**
 * Top-level entry: probe for cli + remote, then spawn the devops agent
 * via `runAgentGate`. Always returns a populated outcome — fail-soft on
 * every failure path so the coordinator never aborts the post-success
 * flow over a missing CLI.
 */
export async function runDevopsAgent(
  opts: RunDevopsOptions,
): Promise<DevopsOutcome> {
  const start = Date.now();
  const skipped = (
    status: DevopsOutcome["status"],
    reason: string,
    sessionId: string | null = null,
    url: string | null = null,
  ): DevopsOutcome => ({
    status,
    url,
    reason,
    devopsSessionId: sessionId,
    durationMs: Date.now() - start,
  });

  if (!opts.targetBranch.trim()) {
    return skipped("skipped", "no `mergeTargetBranch` configured");
  }
  if (!opts.sourceBranch.trim()) {
    return skipped("skipped", "could not determine source branch");
  }
  if (opts.sourceBranch.trim() === opts.targetBranch.trim()) {
    return skipped(
      "skipped",
      `source == target (${opts.targetBranch.trim()}) — nothing to PR`,
    );
  }

  const detect = await detectIntegrationCli(opts.appPath);
  if ("reason" in detect) {
    return skipped(
      detect.reason.includes("not installed") ? "missing-cli" : "no-remote",
      detect.reason,
    );
  }

  const briefBody = renderBrief({
    sourceBranch: opts.sourceBranch,
    targetBranch: opts.targetBranch,
    cli: detect.cli,
    host: detect.host,
    remote: detect.remote,
    taskId: opts.taskId,
  });

  const outcome: AgentGateOutcome = await runAgentGate({
    appPath: opts.appPath,
    taskId: opts.taskId,
    finishedRun: opts.finishedRun,
    taskTitle: opts.taskTitle,
    taskBody: opts.taskBody,
    role: DEVOPS_ROLE,
    briefBody,
    verdictFileName: VERDICT_FILE,
  });

  if (outcome.kind === "skipped") {
    return skipped("skipped", outcome.reason, outcome.sessionId ?? null);
  }
  const parsed = parseDevopsVerdict(outcome.verdict);
  if (!parsed) {
    return skipped(
      "skipped",
      "verdict file did not match `{status, url, cli, reason}` schema",
      outcome.sessionId,
    );
  }
  return {
    status: parsed.status,
    url: parsed.url,
    reason: parsed.reason,
    devopsSessionId: outcome.sessionId,
    durationMs: Date.now() - start,
  };
}

interface BriefArgs {
  sourceBranch: string;
  targetBranch: string;
  cli: IntegrationCli;
  host: IntegrationHost;
  remote: string;
  taskId: string;
}

/**
 * Render the task-specific brief the devops agent sees. The agent's
 * playbook (prompts/playbooks/devops.md) covers process; this block is
 * the per-run wiring (head/base, cli choice, verdict contract).
 */
function renderBrief(args: BriefArgs): string {
  const cliCmd = args.cli === "gh" ? "gh pr create" : "glab mr create";
  const baseFlag = args.cli === "gh" ? "--base" : "--target-branch";
  const headFlag = args.cli === "gh" ? "--head" : "--source-branch";
  return [
    `## Wiring (this run)`,
    "",
    `- **CLI:** \`${args.cli}\` (\`${cliCmd}\`)`,
    `- **Remote host:** ${args.host} — ${args.remote}`,
    `- **Head branch:** \`${args.sourceBranch}\` (the work branch the prior agent committed on)`,
    `- **Base branch:** \`${args.targetBranch}\` (the operator's configured \`mergeTargetBranch\`)`,
    "",
    "## What to do",
    "",
    `1. Run \`git push -u origin ${args.sourceBranch}\` to make sure the head branch is on the remote. Idempotent — already-pushed branches just no-op.`,
    `2. Check whether a PR/MR already exists for this head→base pair. If so, capture its URL and write \`status: "exists"\` in the verdict.`,
    `3. Otherwise run \`${cliCmd} ${baseFlag} ${args.targetBranch} ${headFlag} ${args.sourceBranch}\` with a clean title (use the task title) and a body that summarizes \`## Task\` plus \`git log ${args.targetBranch}..${args.sourceBranch}\`. Capture the URL the CLI prints.`,
    `4. Write the verdict file before exiting.`,
    "",
    "## Verdict file",
    "",
    "Write **exactly one file** named `devops-verdict.json` in the same `sessions/<task-id>/` directory the bridge tells you to put the regular report in:",
    "",
    "```json",
    "{",
    `  "status": "opened" | "exists" | "skipped",`,
    `  "url": "https://.../pull/123" | null,`,
    `  "cli": "${args.cli}",`,
    `  "reason": "one-line summary, max 200 chars"`,
    "}",
    "```",
    "",
    "Use `mkdir -p` before writing if the dir is fresh. Status `skipped` covers any case where you couldn't open a PR (auth missing, push refused, CLI surfaced an error you can't recover from); put the actionable reason in `reason` so the operator can fix it.",
    "",
    "## What NOT to do",
    "",
    "- Don't merge anything yourself. The host's review system owns merge timing.",
    "- Don't create issues, comments, or labels beyond what your playbook authorizes.",
    `- Don't push to \`${args.targetBranch}\`. Ever.`,
    "- Don't run `git commit` — the work branch is already done.",
  ].join("\n");
}
