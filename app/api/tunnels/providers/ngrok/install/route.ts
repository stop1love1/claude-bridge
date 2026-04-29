import { NextResponse } from "next/server";
import { installNgrok } from "@/libs/tunnels";

export const dynamic = "force-dynamic";

/**
 * POST /api/tunnels/providers/ngrok/install
 *
 * Cross-platform installer. Dispatches to winget / brew / tarball
 * download per `libs/tunnels.installerPlan`. Blocks until the install
 * finishes (or its timeout fires) and returns the combined log so the
 * UI can show what happened. Always 200 — `ok: false` in the body
 * signals failure rather than throwing through.
 */
export async function POST() {
  const result = await installNgrok();
  return NextResponse.json(result);
}
