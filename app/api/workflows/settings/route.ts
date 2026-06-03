import { NextResponse, type NextRequest } from "next/server";
import {
  getSchedulerSettings,
  setSchedulerSettings,
} from "@/libs/workflowStore";

export const dynamic = "force-dynamic";

interface SettingsBody {
  cronEnabled?: boolean;
  maxConcurrentRuns?: number;
}

/** GET /api/workflows/settings — global scheduler settings. */
export function GET() {
  return NextResponse.json(getSchedulerSettings());
}

/**
 * PUT /api/workflows/settings — toggle cron auto-runs and set the
 * max-concurrent-runs cap (clamped to [1, 10] in the store).
 */
export async function PUT(req: NextRequest) {
  let body: SettingsBody;
  try {
    body = (await req.json()) as SettingsBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (body.maxConcurrentRuns !== undefined && typeof body.maxConcurrentRuns !== "number") {
    return NextResponse.json(
      { error: "maxConcurrentRuns must be a number" },
      { status: 400 },
    );
  }
  return NextResponse.json(setSchedulerSettings(body));
}
