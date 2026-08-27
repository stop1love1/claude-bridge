import { NextResponse } from "next/server";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { SESSIONS_DIR } from "@/libs/paths";
import { reapStaleRunsForDir } from "@/libs/staleRunReaper";
import { withInFlight } from "@/libs/inFlight";
import { subscribeMetaAll } from "@/libs/meta";

export const dynamic = "force-dynamic";

type MetaPayload = Record<string, unknown>;
const RESPONSE_TTL_MS = 1500;
let responseCache: { value: MetaPayload; expires: number } | null = null;

const G = globalThis as unknown as { __bridgeTasksMetaSub?: boolean };
if (!G.__bridgeTasksMetaSub) {
  G.__bridgeTasksMetaSub = true;
  subscribeMetaAll(() => { responseCache = null; });
}

async function computeMeta(): Promise<MetaPayload> {
  const out: MetaPayload = {};
  if (!existsSync(SESSIONS_DIR)) return out;
  for (const id of readdirSync(SESSIONS_DIR)) {
    const meta = await reapStaleRunsForDir(join(SESSIONS_DIR, id));
    if (meta) out[id] = meta;
  }
  return out;
}

export async function GET() {
  const now = Date.now();
  if (responseCache && responseCache.expires > now) {
    return NextResponse.json(responseCache.value);
  }
  const fresh = await withInFlight("tasks-meta", "all", computeMeta);
  if (fresh !== null) {
    responseCache = { value: fresh, expires: Date.now() + RESPONSE_TTL_MS };
    return NextResponse.json(fresh);
  }
  const after = Date.now();
  if (responseCache && responseCache.expires > after) {
    return NextResponse.json(responseCache.value);
  }
  const fallback = await computeMeta();
  responseCache = { value: fallback, expires: Date.now() + RESPONSE_TTL_MS };
  return NextResponse.json(fallback);
}
