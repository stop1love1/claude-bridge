/**
 * P3b / B4 — recent-direction window.
 *
 * Heuristic: pick a "touched dir" from the task body (using the same
 * scored-symbol approach as `contextAttach`), then run `git log
 * --stat -10 -- <dir>` against the app's working tree. The output
 * tells the agent what's been actively changing in that area —
 * which is far more representative of "where the project is going"
 * than the static symbol index alone.
 *
 * Pure auto-injection: no LLM call, bounded by a 3s git timeout
 * inherited from the agents-route's existing git pre-warm. Returns
 * `null` when no dir scored above threshold or git fails — the
 * caller skips the section in that case.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname } from "node:path";
import type { SymbolIndex } from "./symbolIndex";
import { tokenize, pickCandidateFiles } from "./contextAttach";

const execFileP = promisify(execFile);

const GIT_TIMEOUT_MS = 3000;
const LOG_LINE_CAP = 30;

export interface RecentDirection {
  /** App-relative dir, posix-style separators. */
  dir: string;
  /** Raw `git log --stat -10` stdout, capped at LOG_LINE_CAP lines. */
  log: string;
  /** Whether the log was truncated to the line cap. */
  truncated: boolean;
}

/**
 * Pick a single "touched dir" from the task body. Strategy:
 *   1. Score symbol-index files against task tokens (same path as
 *      contextAttach picks reference files).
 *   2. Take the top-scoring file's parent dir as the focus area.
 *   3. If two top files live in different dirs, prefer the deeper
 *      one (it's more specific) — or fall back to their common
 *      ancestor when the depth is the same.
 *
 * Returns `null` when no file scored above threshold; the caller
 * then skips the recent-direction section entirely.
 */
export function pickTouchedDir(
  taskBody: string,
  symbolIndex: SymbolIndex | null,
): string | null {
  if (!symbolIndex || symbolIndex.symbols.length === 0) return null;
  const tokens = tokenize(taskBody ?? "");
  if (tokens.length === 0) return null;
  const candidates = pickCandidateFiles(symbolIndex.symbols, tokens);
  if (candidates.length === 0) return null;
  const top = candidates[0];
  const dir = dirname(top.file).replace(/\\/g, "/");
  if (!dir || dir === ".") return null;
  return dir;
}

/**
 * Run `git log --stat -10 -- <dir>` in the app cwd. Fails soft to
 * `null` on non-git tree, missing binary, or timeout — the caller
 * just skips the section. We use `execFile` (no shell) so the same
 * call works under bash and PowerShell parents on Windows.
 */
export async function gitLogForDir(
  appCwd: string,
  dir: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileP(
      "git",
      ["log", "--stat", "-10", "--", dir],
      {
        cwd: appCwd,
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 64 * 1024,
      },
    );
    const trimmed = stdout.trim();
    if (!trimmed) return null;
    return trimmed;
  } catch {
    return null;
  }
}

export interface BuildRecentDirectionOptions {
  appCwd: string;
  taskBody: string;
  symbolIndex: SymbolIndex | null;
}

/**
 * Top-level entry. Picks a focus dir, runs git log, returns the
 * capped result. Returns `null` when there's nothing useful to
 * surface — do not render an empty section.
 */
export async function buildRecentDirection(
  opts: BuildRecentDirectionOptions,
): Promise<RecentDirection | null> {
  const dir = pickTouchedDir(opts.taskBody, opts.symbolIndex);
  if (!dir) return null;
  const raw = await gitLogForDir(opts.appCwd, dir);
  if (!raw) return null;
  const lines = raw.split(/\r?\n/);
  const truncated = lines.length > LOG_LINE_CAP;
  const log = truncated ? lines.slice(0, LOG_LINE_CAP).join("\n") : raw;
  return { dir, log, truncated };
}

export const __test = {
  pickTouchedDir,
};
