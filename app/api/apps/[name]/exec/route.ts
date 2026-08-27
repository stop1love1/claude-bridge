import { NextResponse, type NextRequest } from "next/server";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { execLocked, checkBlocklist } from "@/libs/appExecGuard";
import { resolveAppFromRouteSegment } from "@/libs/apps";
import { badRequest } from "@/libs/validate";
import { checkRateLimit } from "@/libs/rateLimit";
import { getClientIp } from "@/libs/clientIp";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Ctx = { params: Promise<{ name: string }> };

interface ExecBody {
  command: string;
}

const TIMEOUT_MS = 30_000;
const OUTPUT_CAP_BYTES = 1024 * 1024;
const COMMAND_CAP_BYTES = 16 * 1024;

export async function POST(req: NextRequest, ctx: Ctx) {
  if (execLocked()) {
    return NextResponse.json(
      { error: "exec endpoint is disabled (BRIDGE_LOCK_EXEC=1)" },
      { status: 403 },
    );
  }

  const denied = checkRateLimit("apps:exec:ip", getClientIp(req.headers), 6, 60_000);
  if (denied) {
    return NextResponse.json(denied.body, { status: denied.status, headers: denied.headers });
  }

  const { name: segment } = await ctx.params;

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

  const app = resolveAppFromRouteSegment(segment);
  if (!app) return NextResponse.json({ error: "app not found" }, { status: 404 });
  const cwd = app.path;
  if (!existsSync(cwd)) {
    return NextResponse.json({ error: "app folder is missing", cwd }, { status: 404 });
  }

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
        try { child.kill("SIGKILL"); } catch { }
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
