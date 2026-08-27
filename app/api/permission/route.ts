import { NextResponse } from "next/server";
import { listAllPending } from "@/libs/permissionStore";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ pending: listAllPending() });
}
