import { NextResponse, type NextRequest } from "next/server";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { resolveAppFromRouteSegment } from "@/libs/apps";
import { detectIntegrationCli, type IntegrationCli } from "@/libs/devops";

export const dynamic = "force-dynamic";
const execFileP = promisify(execFile);
const AUTH_TIMEOUT_MS = 8_000;

type Ctx = { params: Promise<{ name: string }> };

interface AuthProbe {
  authenticated: boolean;
  message: string;
}

async function probeAuth(cli: IntegrationCli): Promise<AuthProbe> {
  try {
    const r = await execFileP(cli, ["auth", "status"], {
      timeout: AUTH_TIMEOUT_MS,
      windowsHide: true,
    });
    const out = (r.stderr || r.stdout).toString().split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
    return { authenticated: true, message: out.trim() || `${cli} auth ok` };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer | string; stdout?: Buffer | string };
    const text = ((typeof e.stderr === "string" ? e.stderr : e.stderr?.toString()) ?? "")
      + ((typeof e.stdout === "string" ? e.stdout : e.stdout?.toString()) ?? "");
    const firstLine = text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
    return {
      authenticated: false,
      message: firstLine.trim() || `${cli} auth check failed`,
    };
  }
}

export async function GET(_req: NextRequest, ctx: Ctx) {
  const { name: segment } = await ctx.params;
  const app = resolveAppFromRouteSegment(segment);
  if (!app) return NextResponse.json({ error: "app not found" }, { status: 404 });
  if (!existsSync(app.path)) {
    return NextResponse.json({ error: "app folder is missing", cwd: app.path }, { status: 404 });
  }

  const detect = await detectIntegrationCli(app.path);
  if ("reason" in detect) {
    return NextResponse.json({
      ok: false,
      stage: "detect",
      reason: detect.reason,
      cli: null,
      host: null,
      remote: null,
      auth: null,
    });
  }

  const auth = await probeAuth(detect.cli);

  return NextResponse.json({
    ok: auth.authenticated,
    stage: auth.authenticated ? "ready" : "auth",
    reason: auth.authenticated
      ? `Ready: \`${detect.cli}\` on \`${detect.host}\` for \`${detect.remote}\``
      : `\`${detect.cli}\` is installed but not authenticated — run \`${detect.cli} auth login\` and retry`,
    cli: detect.cli,
    host: detect.host,
    remote: detect.remote,
    auth,
  });
}
