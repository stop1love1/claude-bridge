
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { treeKill } from "./processKill";

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
      treeKill(child, "SIGTERM");
      setTimeout(() => treeKill(child, "SIGKILL"), 3_000);
      console.warn(`scanApp: timed out after ${SCAN_TIMEOUT_MS}ms in ${appPath}`);
      settle(null);
    }, SCAN_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
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

function extractSummary(raw: string): string | null {
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return null;
  let last = lines[lines.length - 1];
  last = last.replace(/^["'`*_]+|["'`*_]+$/g, "").trim();
  if (last.length === 0) return null;
  if (last === "(no clear purpose)") return last;
  return last.slice(0, MAX_DESCRIPTION_LEN);
}
