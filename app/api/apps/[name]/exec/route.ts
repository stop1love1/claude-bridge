/**
 * Run a one-shot shell command inside an app's working tree.
 *
 * Powers the terminal panel on the app detail page. Synchronous
 * request/response — the operator sends a command line, the bridge
 * runs it, the response is `{ stdout, stderr, exitCode, durationMs,
 * truncated? }`. NOT an interactive PTY — no stdin streaming, no
 * cursor codes, no raw-mode TTY. Use it for `git log`, `pnpm test`,
 * `ls`, `bun run …` — anything that produces output and exits.
 *
 * Authorization model: the operator owns the bridge process; the
 * bridge already runs every spawned agent's tools with the same
 * filesystem and process privileges it has itself. This endpoint
 * doesn't add new attack surface against itself, but it DOES make
 * remote-friendly attacks easier if the bridge is exposed to the
 * network — bind to localhost only, or guard with the existing
 * auth middleware (which this route inherits).
 *
 * Hard limits to keep the route well-behaved:
 *   - 30s wall-clock timeout per command
 *   - 1 MB stdout / 1 MB stderr cap (truncated marker appended)
 *   - 16 KB command-line cap
 *   - basic blocklist for the most-likely-foot-gun shell forms
 *     (rm -rf /, fork bombs, force-pushing to a protected branch).
 *     Operators who really mean to run those bypass via their own
 *     terminal; the blocklist is a "did you mean it" guard not a
 *     security boundary.
 */
import { NextResponse, type NextRequest } from "next/server";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { getApp } from "@/libs/apps";
import { badRequest } from "@/libs/validate";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Ctx = { params: Promise<{ name: string }> };

interface ExecBody {
  command: string;
}

const TIMEOUT_MS = 30_000;
const OUTPUT_CAP_BYTES = 1024 * 1024;
const COMMAND_CAP_BYTES = 16 * 1024;

const BLOCKLIST: Array<{ pattern: RegExp; reason: string }> = [
  // The classic. Block both `/` and `~/` since the bridge process
  // typically has write access to the user's home dir.
  { pattern: /\brm\s+(-[rRfF]+|--recursive|--force)\b.*\s(?:\/|~\/?)\s*$/m, reason: "rm -rf / blocked" },
  { pattern: /\brm\s+(-[rRfF]+|--recursive|--force)\b.*\s\*\s*$/m, reason: "rm -rf * blocked" },
  // Force-push to a protected branch. The blocklist is best-effort —
  // someone determined can bypass with quoting tricks, but the
  // common shapes catch typos.
  { pattern: /\bgit\s+push\s+.*--force(?:-with-lease)?\b.*\b(main|master|develop|production|trunk|release)\b/i, reason: "force-push to protected branch blocked" },
  // Fork-bomb-shaped one-liners.
  { pattern: /:\s*\(\s*\)\s*\{[^}]*\|[^}]*&[^}]*\}\s*;\s*:/, reason: "fork-bomb pattern blocked" },
  // Pipe-from-curl into a shell. Asks for trouble.
  { pattern: /\bcurl\s.+\|\s*(?:bash|sh|zsh|fish)\b/, reason: "curl | shell blocked" },
  { pattern: /\bwget\s.+\|\s*(?:bash|sh|zsh|fish)\b/, reason: "wget | shell blocked" },
];

function checkBlocklist(command: string): { ok: true } | { ok: false; reason: string } {
  for (const { pattern, reason } of BLOCKLIST) {
    if (pattern.test(command)) return { ok: false, reason };
  }
  return { ok: true };
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { name } = await ctx.params;
  if (!name || name.length > 200) return badRequest("invalid app name");

  let body: ExecBody;
  try {
    body = (await req.json()) as ExecBody;
  } catch {
    return badRequest("invalid JSON body");
  }
  const command = (body.command ?? "").trim();
  if (!command) return badRequest("command is required");
  if (command.length > COMMAND_CAP_BYTES) {
    return badRequest(`command too long (max ${COMMAND_CAP_BYTES} bytes)`);
  }
  const blockCheck = checkBlocklist(command);
  if (!blockCheck.ok) {
    return NextResponse.json(
      { error: "command blocked", reason: blockCheck.reason },
      { status: 400 },
    );
  }

  const app = getApp(name);
  if (!app) return NextResponse.json({ error: "app not found" }, { status: 404 });
  const cwd = app.path;
  if (!existsSync(cwd)) {
    return NextResponse.json({ error: "app folder is missing", cwd }, { status: 404 });
  }

  // Use the platform's default shell so quoting / globbing / && / |
  // all work the way the operator expects when they type into a
  // terminal. On Windows this is `cmd.exe /c`; on POSIX it's `sh -c`.
  // We don't honor `$SHELL` because pulling in zsh/fish startup files
  // makes behavior depend on the operator's home dir and timing
  // varies wildly with an over-decorated rc file.
  const isWindows = process.platform === "win32";
  const shell = isWindows ? "cmd.exe" : "sh";
  const shellArgs = isWindows ? ["/d", "/s", "/c", command] : ["-c", command];

  const startedAt = Date.now();
  const child = spawn(shell, shellArgs, {
    cwd,
    windowsHide: true,
    env: process.env,
  });

  let stdout = "";
  let stderr = "";
  let truncatedOut = false;
  let truncatedErr = false;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (stdout.length >= OUTPUT_CAP_BYTES) { truncatedOut = true; return; }
    if (stdout.length + chunk.length > OUTPUT_CAP_BYTES) {
      stdout += chunk.slice(0, OUTPUT_CAP_BYTES - stdout.length);
      truncatedOut = true;
    } else {
      stdout += chunk;
    }
  });
  child.stderr.on("data", (chunk: string) => {
    if (stderr.length >= OUTPUT_CAP_BYTES) { truncatedErr = true; return; }
    if (stderr.length + chunk.length > OUTPUT_CAP_BYTES) {
      stderr += chunk.slice(0, OUTPUT_CAP_BYTES - stderr.length);
      truncatedErr = true;
    } else {
      stderr += chunk;
    }
  });

  const result: { exitCode: number | null; signal: NodeJS.Signals | null } = await new Promise(
    (resolve) => {
      const timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
        resolve({ exitCode: null, signal: "SIGKILL" });
      }, TIMEOUT_MS);
      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        resolve({ exitCode: code, signal });
      });
      child.on("error", () => {
        clearTimeout(timer);
        resolve({ exitCode: null, signal: null });
      });
    },
  );

  if (truncatedOut) stdout += `\n\n…(bridge: stdout truncated at ${OUTPUT_CAP_BYTES} bytes)`;
  if (truncatedErr) stderr += `\n\n…(bridge: stderr truncated at ${OUTPUT_CAP_BYTES} bytes)`;
  return NextResponse.json({
    cwd,
    command,
    stdout,
    stderr,
    exitCode: result.exitCode,
    signal: result.signal,
    durationMs: Date.now() - startedAt,
    truncated: truncatedOut || truncatedErr || undefined,
    timedOut: result.signal === "SIGKILL" && result.exitCode === null,
  });
}
