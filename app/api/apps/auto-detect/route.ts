import { NextResponse } from "next/server";
import { autoDetectApps } from "@/lib/apps";

export const dynamic = "force-dynamic";

export async function POST() {
  const result = autoDetectApps();
  return NextResponse.json(result);
}
