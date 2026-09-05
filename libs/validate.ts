import { NextResponse } from "next/server";
import { isValidRunStatus as isValidRunStatusShared, RUN_STATUSES, type RunStatus } from "./runStatus";

export { RUN_STATUSES, isValidRunStatusShared as isValidRunStatus };
export type { RunStatus };


const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const LABEL_RE = /^[A-Za-z0-9._-]{1,64}$/;


const PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "plan",
  "auto",
  "bypassPermissions",
  "dontAsk",
] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

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

const EFFORT_LEVELS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultracode",
] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export function isValidEffort(s: unknown): s is EffortLevel {
  return typeof s === "string" && (EFFORT_LEVELS as readonly string[]).includes(s);
}

export function isValidSessionId(s: unknown): s is string {
  return typeof s === "string" && UUID_RE.test(s);
}

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

export function isValidPermissionMode(s: unknown): s is PermissionMode {
  return (
    typeof s === "string" &&
    (PERMISSION_MODES as readonly string[]).includes(s)
  );
}

export function isValidUserPermissionMode(s: unknown): s is PermissionMode {
  if (typeof s !== "string") return false;
  const allowed = bypassEnabled()
    ? (USER_SAFE_PERMISSION_MODES_WITH_BYPASS as readonly string[])
    : (USER_SAFE_PERMISSION_MODES as readonly string[]);
  return allowed.includes(s);
}

export function badRequest(msg: string): NextResponse {
  return NextResponse.json({ error: msg }, { status: 400 });
}

/**
 * Parse a task's scheduled start. `null`, `undefined` and `""` mean "no
 * schedule"; any other value must be a parseable date and comes back as a
 * normalised ISO string (so `datetime-local` input lands in UTC on disk).
 */
export function parseScheduledAt(
  v: unknown,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (v === null || v === undefined || v === "") return { ok: true, value: null };
  if (typeof v !== "string") return { ok: false, error: "must be an ISO date string or null" };
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) return { ok: false, error: "not a parseable date" };
  return { ok: true, value: new Date(ms).toISOString() };
}
