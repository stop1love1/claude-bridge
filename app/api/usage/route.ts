import { NextResponse, type NextRequest } from "next/server";
import { readUsageSnapshot } from "@/libs/usageStats";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const force = new URL(req.url).searchParams.get("force") === "1";
  return NextResponse.json(await readUsageSnapshot(force));
}
