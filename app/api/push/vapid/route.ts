import { NextResponse } from "next/server";
import { ensureVapidKeys } from "@/libs/webPush";

export const dynamic = "force-dynamic";

export async function GET() {
  const { publicKey } = ensureVapidKeys();
  return NextResponse.json({ publicKey });
}
