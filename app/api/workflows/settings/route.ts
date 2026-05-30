import { NextResponse, type NextRequest } from "next/server";
import {
  getSchedulerSettings,
  setSchedulerSettings,
} from "@/libs/workflowStore";

export const dynamic = "force-dynamic";

interface SettingsBody {
  autoDispatchEnabled?: boolean;
  maxConcurrentCoordinators?: number;
}

/** GET /api/workflows/settings — global scheduler settings. */
export function GET() {
  return NextResponse.json(getSchedulerSettings());
}

/**
 * PUT /api/workflows/settings — toggle the auto-queue pump and set the
 * concurrency cap. The cap is clamped to [1, 10] in the store.
 */
export async function PUT(req: NextRequest) {
  let body: SettingsBody;
  try {
    body = (await req.json()) as SettingsBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (
    body.maxConcurrentCoordinators !== undefined &&
    typeof body.maxConcurrentCoordinators !== "number"
  ) {
    return NextResponse.json(
      { error: "maxConcurrentCoordinators must be a number" },
      { status: 400 },
    );
  }
  return NextResponse.json(setSchedulerSettings(body));
}
