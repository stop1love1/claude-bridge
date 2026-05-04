import { NextResponse, type NextRequest } from "next/server";
import { addApp, isValidAppName, type App } from "@/libs/apps";

export const dynamic = "force-dynamic";

interface BulkAddItem {
  name?: unknown;
  path?: unknown;
  description?: unknown;
}

interface BulkAddBody {
  apps?: unknown;
}

interface BulkResultItemAdded {
  ok: true;
  app: App;
}

interface BulkResultItemFailed {
  ok: false;
  name: string;
  reason:
    | "invalid-name"
    | "missing-path"
    | "duplicate-name"
    | "invalid-input"
    | "empty"
    | "control-char"
    | "not-absolute"
    | "missing"
    | "not-directory"
    | "outside-allowed-roots";
  detail?: string;
}

type BulkResultItem = BulkResultItemAdded | BulkResultItemFailed;

/**
 * Accept a list of `{name, path, description}` and try to register
 * each one. Returns a per-item outcome so the auto-detect modal can
 * tell the operator exactly which entries succeeded / failed (e.g. a
 * folder name collision after the suggester picked a slug that
 * another tab raced into the registry first).
 *
 * The endpoint is best-effort: a duplicate-name on item 3 doesn't
 * prevent items 4..N from being attempted. The frontend renders the
 * mixed result.
 */
export async function POST(req: NextRequest) {
  let body: BulkAddBody;
  try {
    body = (await req.json()) as BulkAddBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!Array.isArray(body.apps)) {
    return NextResponse.json({ error: "apps[] required" }, { status: 400 });
  }
  if (body.apps.length === 0) {
    return NextResponse.json({ added: [], failed: [] });
  }

  const added: App[] = [];
  const failed: BulkResultItemFailed[] = [];

  for (const raw of body.apps) {
    const item = (raw ?? {}) as BulkAddItem;
    const name = typeof item.name === "string" ? item.name.trim() : "";
    const path = typeof item.path === "string" ? item.path.trim() : "";
    const description = typeof item.description === "string" ? item.description.trim() : "";

    if (!isValidAppName(name) || !path) {
      failed.push({ ok: false, name: name || "(unnamed)", reason: "invalid-input" });
      continue;
    }
    const result = addApp({ name, path, description });
    if (result.ok) added.push(result.app);
    else {
      const item: BulkResultItemFailed = { ok: false, name, reason: result.reason };
      if (result.detail) item.detail = result.detail;
      failed.push(item);
    }
  }

  return NextResponse.json({ added, failed }, { status: 201 });
}

export type { BulkResultItem };
