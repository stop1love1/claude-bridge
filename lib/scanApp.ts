/**
 * Ask the Claude CLI to read a repo and produce a one-sentence
 * description of what it does. Used by the apps auto-detect flow to
 * replace the package.json / README first-line heuristic with a
 * model-grounded summary.
 *
 * The scan is read-only: we run with `--permission-mode bypassPermissions`
 * so the model never prompts for tool approval, but the prompt itself
 * tells it to inspect surface files only and return prose. No diff is
 * applied to the repo.
 *
 * Failure modes (timeout, non-zero exit, missing CLI) all resolve to
 * `null`. The caller falls back to whatever description it already had.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const SCAN_TIMEOUT_MS = 90_000;
const MAX_DESCRIPTION_LEN = 240;

const PROMPT = [
  "You are scanning this repository to register it in a multi-repo coordinator.",
  "",
  "Read at most: README.md, CLAUDE.md, package.json, AGENTS.md, the names of",
  "top-level directories, and the names of files inside `src/` or `app/` if those exist.",
  "",
  "Respond with EXACTLY ONE sentence (under 200 characters) describing what this",
  "project does and what stack it runs on. Examples of good answers:",
  "  - \"Next.js + Tailwind dashboard for managing Claude Code agents across sibling repos.\"",
  "  - \"NestJS + Prisma backend exposing REST endpoints for an LMS (courses, enrollment, auth).\"",
  "  - \"Python ETL pipeline that ingests CSVs from S3 into a Postgres warehouse.\"",
  "",
  "Rules:",
  "- One sentence. No bullet list, no headings, no quotes around the answer.",
  "- No preamble like \"This project is\" — start with the noun phrase.",
  "- If the repo is too thin to summarise, output exactly: (no clear purpose)",
].join("\n");

/**
 * Run `claude -p` in `appPath` and return the model's one-sentence
 * answer. Returns `null` on any failure so the caller can keep its
 * existing description.
 */
export async function scanAppWithClaude(appPath: string): Promise<string | null> {
  if (!existsSync(appPath)) return null;
  return new Promise<string | null>((resolveScan) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const child = spawn(
      CLAUDE_BIN,
      [
        "-p",
        "--permission-mode", "bypassPermissions",
        PROMPT,
      ],
      {
        cwd: appPath,
        stdio: ["ignore", "pipe", "pipe"],
        // Detach so a sluggish scan can't pile up zombie sub-processes
        // when the request handler is GC'd. Killed via SIGTERM below.
        windowsHide: true,
      },
    );

    const settle = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveScan(value);
    };

    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      // Force kill 3 seconds after if still alive.
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } }, 3_000);
      console.warn(`scanApp: timed out after ${SCAN_TIMEOUT_MS}ms in ${appPath}`);
      settle(null);
    }, SCAN_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      // Cap accumulated stdout so a runaway claude doesn't eat memory.
      if (stdout.length > 32 * 1024) stdout = stdout.slice(-32 * 1024);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 8 * 1024) stderr = stderr.slice(-8 * 1024);
    });

    child.on("error", (err) => {
      console.warn(`scanApp: spawn error in ${appPath}`, err.message);
      settle(null);
    });

    child.on("exit", (code) => {
      if (code !== 0) {
        const tail = stderr.trim().split("\n").slice(-3).join(" | ");
        console.warn(`scanApp: claude exited ${code} in ${appPath}: ${tail}`);
        settle(null);
        return;
      }
      const summary = extractSummary(stdout);
      settle(summary);
    });
  });
}

/**
 * Pull the last non-empty line of stdout — `claude -p` ends its
 * response with the assistant's final message, so the trailing line
 * is what we want. Trim, drop quote wrappers, cap length.
 */
function extractSummary(raw: string): string | null {
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return null;
  let last = lines[lines.length - 1];
  // Strip surrounding quotes / asterisks the model sometimes adds even
  // when told not to.
  last = last.replace(/^["'`*_]+|["'`*_]+$/g, "").trim();
  if (last.length === 0) return null;
  if (last === "(no clear purpose)") return last;
  return last.slice(0, MAX_DESCRIPTION_LEN);
}
