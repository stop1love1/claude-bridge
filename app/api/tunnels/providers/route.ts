import { NextResponse } from "next/server";
import { detectProviders } from "@/libs/tunnels";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ providers: detectProviders() });
}
