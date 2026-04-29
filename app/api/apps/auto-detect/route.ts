import { NextResponse, type NextRequest } from "next/server";
import { autoDetectApps } from "@/libs/apps";

export const dynamic = "force-dynamic";

/**
 * Backward-compat endpoint for the Telegram surface and any older
 * caller. Auto-confirms every detected candidate. The UI uses the
 * SSE stream + `/api/apps/bulk` flow instead, which lets the operator
 * review and pick before anything is written to `bridge.json`.
 */
export async function POST(_req: NextRequest) {
  const result = await autoDetectApps();
  return NextResponse.json(result);
}
