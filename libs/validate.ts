import { NextResponse } from "next/server";
import { isValidRunStatus as isValidRunStatusShared, RUN_STATUSES, type RunStatus } from "./runStatus";

// Re-export so existing imports `from "./validate"` keep working.
export { RUN_STATUSES, isValidRunStatusShared as isValidRunStatus };
export type { RunStatus };

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
 *     in `libs/tasksStore.ts`) stay in place — defense in depth.
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

// `RUN_STATUSES` / `RunStatus` / `isValidRunStatus` now live in
// `./runStatus.ts` so the client bundle can import them without pulling
// in NextResponse. Re-exported above for back-compat.

/**
 * Allowed values for `ChatSettings.mode` — kept in sync with the enum
 * declared in `libs/spawn.ts` (the canonical list, since that module
 * actually shells out to `claude --permission-mode`). Duplicated here
 * as a frozen tuple so route handlers can validate untrusted bodies
 * without pulling in the full spawn module.
 */
const PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "plan",
  "auto",
  "bypassPermissions",
  "dontAsk",
] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/**
 * Subset of `PERMISSION_MODES` that the operator UI exposes — the
 * composer's mode dropdown only offers these four. The public chat
 * routes accept user-typed messages, so they MUST reject
 * `bypassPermissions` / `dontAsk` (which would let an attacker who
 * landed an XSS or a CSRF skip the permission popup entirely). The
 * coordinator / agents routes that genuinely need bypass mode pass
 * `mode: "bypassPermissions"` from server-side code, never relayed
 * from the request body.
 *
 * Single-user localhost setups can opt in to `bypassPermissions` from
 * the composer by setting `NEXT_PUBLIC_BRIDGE_ALLOW_BYPASS=1`; the
 * env gate is read at request time so a deploy can toggle it without
 * a code change.
 */
const USER_SAFE_PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "plan",
  "auto",
] as const;

const USER_SAFE_PERMISSION_MODES_WITH_BYPASS = [
  ...USER_SAFE_PERMISSION_MODES,
  "bypassPermissions",
] as const;

function bypassEnabled(): boolean {
  return process.env.NEXT_PUBLIC_BRIDGE_ALLOW_BYPASS === "1";
}

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

/**
 * Type-guard for `ChatSettings.mode`. Accepts only the documented
 * `claude --permission-mode` values; anything else (including the
 * empty string) is rejected so a caller can't sneak `bypassPermissions`
 * past the UI by spoofing arbitrary text.
 */
export function isValidPermissionMode(s: unknown): s is PermissionMode {
  return (
    typeof s === "string" &&
    (PERMISSION_MODES as readonly string[]).includes(s)
  );
}

/**
 * Stricter variant for routes that accept user-typed input. Rejects
 * the privileged modes (`bypassPermissions`, `dontAsk`) so a hostile
 * body can't claim them. Use this in any route the browser composer
 * talks to; use `isValidPermissionMode` only on routes that are
 * authenticated by `INTERNAL_TOKEN_HEADER` and explicitly trusted.
 */
export function isValidUserPermissionMode(s: unknown): s is PermissionMode {
  if (typeof s !== "string") return false;
  const allowed = bypassEnabled()
    ? (USER_SAFE_PERMISSION_MODES_WITH_BYPASS as readonly string[])
    : (USER_SAFE_PERMISSION_MODES as readonly string[]);
  return allowed.includes(s);
}

/**
 * Standard 400 helper — every route here returns the same `{error}` shape
 * for invalid inputs, so this saves a line per validation failure.
 */
export function badRequest(msg: string): NextResponse {
  return NextResponse.json({ error: msg }, { status: 400 });
}
