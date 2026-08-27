import { NextResponse, type NextRequest } from "next/server";
import { detectProviders, setNgrokAuthtoken } from "@/libs/tunnels";

export const dynamic = "force-dynamic";

interface PutBody {
  authtoken?: unknown;
}

export async function PUT(req: NextRequest) {
  let body: PutBody;
  try {
    body = (await req.json()) as PutBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (typeof body.authtoken !== "string") {
    return NextResponse.json(
      { error: "authtoken must be a string (use \"\" to clear)" },
      { status: 400 },
    );
  }
  const authtoken = body.authtoken.trim();
  if (authtoken.length > 1024) {
    return NextResponse.json(
      { error: "authtoken too long (max 1024 chars)" },
      { status: 400 },
    );
  }
  setNgrokAuthtoken(authtoken);
  return NextResponse.json({ providers: detectProviders() });
}
