
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { treeKill } from "../processKill";
import { BRIDGE_ROOT } from "../paths";
import type { DetectInput, DetectedScope, RepoMatch } from "./types";

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const DETECT_TIMEOUT_MS = 60_000;
const STDOUT_CAP_BYTES = 64 * 1024;
const STDERR_CAP_BYTES = 8 * 1024;

export async function detectWithLLM(
  input: DetectInput,
): Promise<DetectedScope | null> {
  if (!existsSync(BRIDGE_ROOT)) return null;
  if (input.repos.length === 0) return null;

  const prompt = buildLLMPrompt(input);
  const raw = await runClaude(prompt);
  if (!raw) return null;

  return parseLLMResponse(raw, input);
}

function buildLLMPrompt(input: DetectInput): string {
  const profiles = input.profiles ?? {};
  const capabilities = input.capabilities ?? {};
  const lines: string[] = [];

  lines.push(
    "You are a detection helper for a multi-repo coordinator.",
    "Read the task below and return ONE JSON object describing which",
    "repo(s) it touches, what features / domain entities it involves,",
    "and any specific files it mentions.",
    "",
    "## Task",
    "",
    `Title: ${input.taskTitle ?? "(none)"}`,
    "",
    "Body (verbatim):",
    "```",
    input.taskBody ?? "",
    "```",
    "",
    "## Candidate repos",
    "",
  );

  for (const name of input.repos) {
    const p = profiles[name];
    const caps = capabilities[name] ?? [];
    const stack = p?.stack?.length ? p.stack.join(", ") : "(unknown)";
    const features = p?.features?.length ? p.features.join(", ") : "(none)";
    const summary = p?.summary?.trim() || "(no summary)";
    const capLine = caps.length > 0 ? caps.join(", ") : "(none declared)";
    lines.push(
      `- **${name}** — ${summary}`,
      `  Stack: ${stack}. Features: ${features}.`,
      `  Declared capabilities: ${capLine}.`,
    );
  }

  if (input.pinnedRepo) {
    lines.push(
      "",
      `## User pin`,
      "",
      `The user explicitly chose **${input.pinnedRepo}** as the target. Set \`source\` to \`"user-pinned"\` and put that repo first in \`repos\` regardless of your own analysis. You can still surface a runner-up if the task body would naturally route elsewhere.`,
    );
  }

  lines.push(
    "",
    "## Output contract",
    "",
    "Respond with ONE fenced JSON code block — nothing before, nothing after:",
    "",
    "```json",
    "{",
    '  "repos": [',
    '    { "name": "<repo from the candidate list>", "score": <integer 1-100>, "reason": "<short reason>" }',
    "  ],",
    '  "features": ["<canonical feature label, e.g. \\"lms.course\\" or \\"auth.login\\">"],',
    '  "entities": ["<domain entity, lowercase singular, e.g. \\"course\\", \\"student\\">"],',
    '  "files": ["<explicit path or glob mentioned in the task>"],',
    '  "confidence": "high|medium|low",',
    '  "reason": "<one-line summary of your decision>"',
    "}",
    "```",
    "",
    "Rules:",
    "- `repos[]` contains ONLY names from the candidate list. Sort by score descending.",
    "- `features[]` use lowercase, dot-namespaced labels. Reuse declared capabilities verbatim when they apply.",
    "- `entities[]` are SINGULAR nouns. Mirror the user's language as a comment if useful, but use the English/canonical singular here.",
    "- `files[]` MUST be paths the task body literally mentions. Empty array if none.",
    "- `confidence`: `high` only when you have a clear winner repo AND obvious feature signal; `medium` when one is clear but not both; `low` when the task is vague or spans multiple repos equally.",
    "- Do NOT include any prose outside the JSON block.",
    "- Do NOT add fields outside the schema.",
  );

  return lines.join("\n");
}

function runClaude(prompt: string): Promise<string | null> {
  return new Promise<string | null>((resolveRun) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const child = spawn(
      CLAUDE_BIN,
      ["-p", "--permission-mode", "bypassPermissions", prompt],
      {
        cwd: BRIDGE_ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );

    const settle = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun(value);
    };

    const timer = setTimeout(() => {
      treeKill(child, "SIGTERM");
      setTimeout(() => treeKill(child, "SIGKILL"), 3_000);
      console.warn(`[detect/llm] timed out after ${DETECT_TIMEOUT_MS}ms`);
      settle(null);
    }, DETECT_TIMEOUT_MS);

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
      console.warn(`[detect/llm] spawn error:`, err.message);
      settle(null);
    });
    child.on("exit", (code) => {
      if (code !== 0) {
        const tail = stderr.trim().split("\n").slice(-3).join(" | ");
        console.warn(`[detect/llm] claude exited ${code}: ${tail}`);
        settle(null);
        return;
      }
      settle(stdout);
    });
  });
}

function parseLLMResponse(
  raw: string,
  input: DetectInput,
): DetectedScope | null {
  const json = extractJsonBlock(raw);
  if (!json) {
    console.warn("[detect/llm] no JSON block in response");
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    console.warn("[detect/llm] JSON parse failed:", (err as Error).message);
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const obj = parsed as Record<string, unknown>;
  const allowedRepos = new Set(input.repos);

  const reposRaw = Array.isArray(obj.repos) ? obj.repos : [];
  const repos: RepoMatch[] = [];
  for (const r of reposRaw) {
    if (!r || typeof r !== "object") continue;
    const rec = r as Record<string, unknown>;
    const name = typeof rec.name === "string" ? rec.name.trim() : "";
    if (!name || !allowedRepos.has(name)) continue;
    const score = typeof rec.score === "number" ? Math.max(0, Math.floor(rec.score)) : 0;
    const reason = typeof rec.reason === "string" ? rec.reason.trim() : "";
    if (repos.some((m) => m.name === name)) continue;
    repos.push({ name, score, reason: reason || "(llm: no reason)" });
  }
  repos.sort((a, b) => b.score - a.score);

  const features = sanitizeStringList(obj.features);
  const entities = sanitizeStringList(obj.entities);
  const files = sanitizeStringList(obj.files, 200);

  const confidenceRaw = typeof obj.confidence === "string" ? obj.confidence.trim().toLowerCase() : "";
  const confidence: DetectedScope["confidence"] =
    confidenceRaw === "high" || confidenceRaw === "medium" || confidenceRaw === "low"
      ? confidenceRaw
      : "low";

  const reason = typeof obj.reason === "string" && obj.reason.trim().length > 0
    ? obj.reason.trim().slice(0, 400)
    : "llm: (no reason)";

  let finalRepos = repos;
  let source: DetectedScope["source"] = "llm";
  if (input.pinnedRepo && allowedRepos.has(input.pinnedRepo)) {
    source = "user-pinned";
    const existing = finalRepos.find((r) => r.name === input.pinnedRepo);
    const pinned: RepoMatch = existing
      ? { ...existing, reason: `user-pinned (${existing.reason})` }
      : { name: input.pinnedRepo, score: 0, reason: "user-pinned via NewSessionDialog" };
    finalRepos = [pinned, ...finalRepos.filter((r) => r.name !== input.pinnedRepo)];
  }

  return {
    repos: finalRepos,
    features,
    entities,
    files,
    confidence: source === "user-pinned" ? "high" : confidence,
    source,
    detectedAt: new Date().toISOString(),
    reason,
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

function sanitizeStringList(raw: unknown, lenCap = 80): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const trimmed = v.trim().slice(0, lenCap);
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}
