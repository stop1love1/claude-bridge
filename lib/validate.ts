import { NextResponse } from "next/server";

/**
 * Shared input validators for the API layer.
 *
 * These helpers gate untrusted route params (`[sessionId]`, `[requestId]`,
 * `body.role`, `body.repo`, …) at the *very top* of each handler so a
 * downstream `path.join(SESSIONS_DIR, id)` or `${run.role}-${run.repo}`
 * template can't be turned into a traversal payload.
 *
 * Conventions:
 *   - All `isValid*` helpers return a TS type-guard so callers can use
 *     them as an early-return narrow without re-asserting types later.
 *   - All helpers reject non-strings, empty strings, and anything past
 *     the documented charset/length window.
 *   - These add an early gate; existing safety nets (e.g. `safeSessionDir`
 *     in `lib/tasksStore.ts`) stay in place — defense in depth.
 */

/** UUID v4-ish shape used by Claude Code session ids. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Conservative label charset shared by role / repo / tool name.
 * Allows letters, digits, dot, dash, underscore — everything else
 * (slashes, backslashes, colons, null bytes, whitespace) is rejected.
 * 1..64 chars keeps generated filenames bounded.
 */
const LABEL_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** Allowed values for a task run's lifecycle status. */
const RUN_STATUSES = ["queued", "running", "done", "failed", "stale"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export function isValidSessionId(s: unknown): s is string {
  return typeof s === "string" && UUID_RE.test(s);
}

/** Permission requestId shares the same UUID shape as a session id. */
export function isValidRequestId(s: unknown): s is string {
  return isValidSessionId(s);
}

export function isValidAgentRole(s: unknown): s is string {
  return typeof s === "string" && LABEL_RE.test(s);
}

export function isValidRepoLabel(s: unknown): s is string {
  return typeof s === "string" && LABEL_RE.test(s);
}

export function isValidToolName(s: unknown): s is string {
  return typeof s === "string" && LABEL_RE.test(s);
}

export function isValidRunStatus(s: unknown): s is RunStatus {
  return (
    typeof s === "string" && (RUN_STATUSES as readonly string[]).includes(s)
  );
}

/**
 * Standard 400 helper — every route here returns the same `{error}` shape
 * for invalid inputs, so this saves a line per validation failure.
 */
export function badRequest(msg: string): NextResponse {
  return NextResponse.json({ error: msg }, { status: 400 });
}
