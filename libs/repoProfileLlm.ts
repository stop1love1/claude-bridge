import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { treeKill } from "./processKill";
import { BRIDGE_ROOT } from "./paths";
import { readOnlyChildArgs } from "./spawn";
import { isValidModel } from "./validate";
import { logWarn } from "./log";
import type { RepoProfile } from "./repoProfile";

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const PROFILE_TIMEOUT_MS = 60_000;
const STDOUT_CAP_BYTES = 64 * 1024;
const STDERR_CAP_BYTES = 8 * 1024;

const SUMMARY_CAP_CHARS = 400;
const FEATURE_CAP_CHARS = 40;
const FEATURE_CAP_COUNT = 12;
/** Lowercase, optionally dot-namespaced: `auth`, `lms.course`, `ci.pr-review`. */
const FEATURE_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

export interface SummarizeOptions {
  /** Optional model pin for the auxiliary spawn. Invalid values are ignored. */
  model?: string;
}

/**
 * Enrich a heuristic profile with a short LLM-written summary.
 *
 * Never throws and never rejects: any failure (missing CLI, non-zero exit,
 * timeout, malformed JSON) resolves to the input profile untouched, so the
 * caller keeps the heuristic result it already had.
 */
export async function summarizeWithLLM(
  profile: RepoProfile,
  opts: SummarizeOptions = {},
): Promise<RepoProfile> {
  try {
    if (!existsSync(profile.path)) return profile;
    const raw = await runClaude(buildProfileLLMPrompt(profile), profile.path, opts.model);
    if (!raw) return profile;
    return applyProfileLLMResponse(raw, profile) ?? profile;
  } catch (err) {
    logWarn("profile-llm", "summarize failed (non-fatal)", {
      repo: profile.name,
      error: (err as Error).message,
    });
    return profile;
  }
}

export function buildProfileLLMPrompt(profile: RepoProfile): string {
  const lines: string[] = [];
  const stack = profile.stack.length > 0 ? profile.stack.join(", ") : "(unknown)";
  const features = profile.features.length > 0 ? profile.features.join(", ") : "(none)";
  const keywords = profile.keywords.slice(0, 20).join(", ") || "(none)";
  const counts = Object.entries(profile.fileCounts)
    .map(([ext, n]) => `${ext}×${n}`)
    .join(", ") || "(none)";

  lines.push(
    "You are a repo-profiling helper for a multi-repo coordinator.",
    "You are running INSIDE the repo described below. Read a handful of the",
    "most telling files (README, CLAUDE.md, package manifest, the entrypoints",
    "listed) and return ONE JSON object describing what this repo actually is.",
    "Be concrete: the summary is shown to another agent that must decide",
    "whether a task belongs to this repo.",
    "",
    "## Heuristic profile (already computed — correct it, don't just echo it)",
    "",
    `- Name: ${profile.name}`,
    `- Current summary: ${profile.summary || "(none)"}`,
    `- Stack: ${stack}`,
    `- Features: ${features}`,
    `- Keywords: ${keywords}`,
    `- File counts: ${counts}`,
    `- Primary language: ${profile.signals.primaryLang}. Router style: ${profile.signals.routerStyle}.`,
    "",
    "## Known entrypoint globs",
    "",
  );

  if (profile.entrypoints.length > 0) {
    for (const ep of profile.entrypoints) lines.push(`- \`${ep}\``);
  } else {
    lines.push("- (none detected)");
  }

  lines.push(
    "",
    "## Output contract",
    "",
    "Respond with ONE fenced JSON code block — nothing before, nothing after:",
    "",
    "```json",
    "{",
    '  "summary": "<1-2 sentences: what this repo is and what it is for>",',
    '  "features": ["<lowercase dot-namespaced label, e.g. \\"auth\\" or \\"lms.course\\">"],',
    '  "entrypoints": ["<glob copied VERBATIM from the list above>"]',
    "}",
    "",
    "```",
    "",
    "Rules:",
    `- \`summary\` is plain prose, at most ${SUMMARY_CAP_CHARS} characters, no markdown, no repo path.`,
    "- `features[]` are lowercase, dot-namespaced labels. Reuse the heuristic",
    "  features verbatim when they are right; add the ones it missed.",
    "- `entrypoints[]` MUST be a subset of the known entrypoint globs above.",
    "  Anything else is dropped. Keep only the globs that really are the way in.",
    "- Do NOT add fields outside the schema. Do NOT include prose outside the JSON block.",
  );

  return lines.join("\n");
}

export function buildProfileLLMArgs(prompt: string, model?: string): string[] {
  const args = ["-p", "--permission-mode", "bypassPermissions", prompt];
  if (isValidModel(model)) args.push("--model", model);
  return [...args, ...readOnlyChildArgs()];
}

function runClaude(
  prompt: string,
  cwd: string,
  model?: string,
): Promise<string | null> {
  return new Promise<string | null>((resolveRun) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const child = spawn(CLAUDE_BIN, buildProfileLLMArgs(prompt, model), {
      cwd: existsSync(cwd) ? cwd : BRIDGE_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    // The SIGKILL follow-up outlives settle(), so it is tracked separately and
    // cleared when the child exits — otherwise it holds the event loop open for
    // another 3s in a short-lived process (a test run, a one-shot CLI).
    let killTimer: NodeJS.Timeout | null = null;

    const settle = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun(value);
    };

    const timer = setTimeout(() => {
      treeKill(child, "SIGTERM");
      killTimer = setTimeout(() => treeKill(child, "SIGKILL"), 3_000);
      logWarn("profile-llm", `timed out after ${PROFILE_TIMEOUT_MS}ms`);
      settle(null);
    }, PROFILE_TIMEOUT_MS);

    child.on("close", () => {
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
    });

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > STDOUT_CAP_BYTES) {
        stdout = stdout.slice(-STDOUT_CAP_BYTES);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > STDERR_CAP_BYTES) {
        stderr = stderr.slice(-STDERR_CAP_BYTES);
      }
    });

    child.on("error", (err) => {
      logWarn("profile-llm", "spawn error", { error: err.message });
      settle(null);
    });
    child.on("exit", (code) => {
      if (code !== 0) {
        const tail = stderr.trim().split("\n").slice(-3).join(" | ");
        logWarn("profile-llm", `claude exited ${code}: ${tail}`);
        settle(null);
        return;
      }
      settle(stdout);
    });
  });
}

/**
 * Merge a raw CLI response into the heuristic profile.
 *
 * Returns `null` when the response carries nothing usable, so the caller can
 * keep the heuristic profile byte-for-byte (including the absent
 * `summarySource`, which is what makes an untouched profile round-trip).
 */
export function applyProfileLLMResponse(
  raw: string,
  profile: RepoProfile,
): RepoProfile | null {
  const json = extractJsonBlock(raw);
  if (!json) {
    logWarn("profile-llm", "no JSON block in response", { repo: profile.name });
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    logWarn("profile-llm", "JSON parse failed", {
      repo: profile.name,
      error: (err as Error).message,
    });
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    logWarn("profile-llm", "response was not a JSON object", { repo: profile.name });
    return null;
  }

  const obj = parsed as Record<string, unknown>;

  const summary =
    typeof obj.summary === "string" ? collapseWhitespace(obj.summary).slice(0, SUMMARY_CAP_CHARS) : "";

  const llmFeatures = sanitizeFeatures(obj.features);
  const features = dedupe([...profile.features, ...llmFeatures]).slice(0, FEATURE_CAP_COUNT);

  // The model may only narrow the heuristic entrypoints, never invent one.
  const allowed = new Set(profile.entrypoints);
  const picked = Array.isArray(obj.entrypoints)
    ? dedupe(
        obj.entrypoints.filter(
          (e): e is string => typeof e === "string" && allowed.has(e),
        ),
      )
    : [];
  const entrypoints = picked.length > 0 ? picked : profile.entrypoints;

  const changed =
    (summary.length > 0 && summary !== profile.summary) ||
    features.length !== profile.features.length ||
    entrypoints.length !== profile.entrypoints.length;
  if (!changed) return null;

  return {
    ...profile,
    summary: summary || profile.summary,
    features,
    entrypoints,
    summarySource: "llm",
  };
}

function extractJsonBlock(raw: string): string | null {
  const fenced = raw.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenced && fenced[1]) return fenced[1].trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  return raw.slice(start, end + 1);
}

function sanitizeFeatures(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const label = v.trim().toLowerCase().slice(0, FEATURE_CAP_CHARS);
    if (!label || !FEATURE_RE.test(label)) continue;
    out.push(label);
  }
  return dedupe(out);
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function dedupe<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

export const __test = {
  FEATURE_RE,
  SUMMARY_CAP_CHARS,
  FEATURE_CAP_COUNT,
  PROFILE_TIMEOUT_MS,
  extractJsonBlock,
  sanitizeFeatures,
};
