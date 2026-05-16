/**
 * Devops connection-check probe for an app.
 *
 * Tells the operator — in advance — whether `integrationMode:
 * "pull-request"` is actually going to work for this app:
 *
 *   1. Is the directory a git repo with an `origin` remote?
 *   2. Did we classify the host (github / gitlab) — or is it self-hosted?
 *   3. Is the matching CLI installed and authenticated?
 *
 * Returns a structured payload the Settings UI renders next to the
 * "Pull request" radio so the operator can fix the missing prereq
 * before saving the setting and being surprised at runtime.
 *
 * GET /api/apps/<name>/devops-check
 */
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
  /** True iff `<cli> auth status` exited 0. */
  authenticated: boolean;
  /** Short message — first non-empty line of stderr from the auth probe. */
  message: string;
}

/**
 * Probe whether the operator is logged in. `gh auth status` and
 * `glab auth status` both write a human-readable summary to stderr
 * and exit 0 on success / 1 on missing auth. We grab the first
 * non-empty line so the UI has something concrete to display.
 */
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

  // Step 1 + 2: detect cli + remote.
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

  // Step 3: auth probe.
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
