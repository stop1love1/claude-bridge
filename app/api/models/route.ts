import { NextResponse } from "next/server";
import { discoverModels } from "@/libs/modelDiscovery";
import { readUsageSnapshot } from "@/libs/usageStats";

export const dynamic = "force-dynamic";

/**
 * Models the composer may offer. Discovered, never hardcoded: the aliases come
 * from the installed CLI's own `--model` help, and the ids come from what this
 * machine has actually run. A cached snapshot is used for the latter so this
 * stays cheap — a stale-by-minutes model list is fine.
 */
export async function GET() {
  let seen: string[] = [];
  try {
    const snap = await readUsageSnapshot();
    seen = Object.keys(snap.modelUsage ?? {});
  } catch {
    // Usage is a convenience here; the CLI aliases alone still give a picker.
  }
  return NextResponse.json({ models: discoverModels(seen) });
}
