import { NextResponse, type NextRequest } from "next/server";
import { autoDetectApps } from "@/libs/apps";

export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest) {
  const result = await autoDetectApps();
  return NextResponse.json(result);
}
