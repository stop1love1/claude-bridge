import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname } from "node:path";
import type { SymbolIndex } from "./symbolIndex";
import { tokenize, pickCandidateFiles } from "./contextAttach";

const execFileP = promisify(execFile);

const GIT_TIMEOUT_MS = 3000;
const LOG_LINE_CAP = 30;

export interface RecentDirection {
  dir: string;
  log: string;
  truncated: boolean;
}

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
