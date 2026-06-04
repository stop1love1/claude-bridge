/**
 * Deny-by-default authorization for guest (task-share) requests.
 *
 * This is the security core of the share feature. A guest cookie proves
 * only WHO the request is (which share + device); this module decides
 * WHAT a guest may touch. The rule set is an explicit allowlist bound to
 * the share's `taskId` and gated by the share's grants — anything not
 * listed is rejected. See `docs/superpowers/specs/2026-05-30-task-share-
 * links-design.md`.
 *
 * `authorizeGuestRequest` is pure: it takes the request method + path +
 * the guest's scope + a `sessionInTask` predicate (injected so it stays
 * unit-testable). The proxy supplies the real predicate via
 * `sessionBelongsToTask`, which reads the task's meta.json.
 */

import { join } from "node:path";
import { readMeta } from "./meta";
import { SESSIONS_DIR } from "./paths";
import type { ShareGrants } from "./shareStore";

export interface GuestScope {
  taskId: string;
  grants: ShareGrants;
}

/** True when `sessionId` is a run of the guest's task. */
export type SessionInTask = (sessionId: string) => boolean;

export interface GuestAuthResult {
  ok: boolean;
  reason?: string;
}

type GrantKey = keyof ShareGrants;

interface Rule {
  method: "GET" | "POST";
  /** Path segments after `/api/`; `:tid`/`:sid`/`:rid` are captures. */
  pattern: string[];
  /** Required grant, or null for the always-allowed view baseline. */
  grant: GrantKey | null;
  /** When true, the captured `:sid` must belong to the guest's task. */
  checkSession?: boolean;
}

// Patterns are matched against the path AFTER the leading `/api/`.
// `:tid` must equal the guest's taskId; `:sid`/`:rid` are wildcards
// (a `:sid` under `/sessions/` is additionally verified via checkSession,
// while a `:sid` nested under `/tasks/:tid/runs/` is already task-scoped).
const RULES: Rule[] = [
  // ── Read (view baseline) ────────────────────────────────────────
  { method: "GET", pattern: ["tasks", ":tid", "meta"], grant: null },
  { method: "GET", pattern: ["tasks", ":tid", "summary"], grant: null },
  { method: "GET", pattern: ["tasks", ":tid", "usage"], grant: null },
  { method: "GET", pattern: ["tasks", ":tid", "events"], grant: null },
  { method: "GET", pattern: ["tasks", ":tid", "runs", ":sid", "prompt"], grant: null },
  { method: "GET", pattern: ["tasks", ":tid", "runs", ":sid", "diff"], grant: null },
  // Plan-gate: any task guest may view the intake plan.
  { method: "GET", pattern: ["tasks", ":tid", "plan"], grant: null },
  // Live preview (Epic C): gated behind its own grant.
  { method: "GET", pattern: ["tasks", ":tid", "preview"], grant: "viewPreview" },
  // Presence (Epic D): any task viewer participates — view baseline.
  { method: "GET", pattern: ["tasks", ":tid", "presence"], grant: null },
  { method: "POST", pattern: ["tasks", ":tid", "presence"], grant: null },
  { method: "GET", pattern: ["sessions", ":sid", "tail"], grant: null, checkSession: true },
  { method: "GET", pattern: ["sessions", ":sid", "tail", "stream"], grant: null, checkSession: true },
  { method: "GET", pattern: ["sessions", ":sid", "permission"], grant: null, checkSession: true },
  { method: "GET", pattern: ["sessions", ":sid", "permission", "stream"], grant: null, checkSession: true },

  // ── Send / drive (grant: sendMessage) ───────────────────────────
  { method: "POST", pattern: ["sessions", ":sid", "message"], grant: "sendMessage", checkSession: true },
  { method: "POST", pattern: ["sessions", ":sid", "upload"], grant: "sendMessage", checkSession: true },
  { method: "POST", pattern: ["sessions", ":sid", "kill"], grant: "sendMessage", checkSession: true },
  // Spawning NEW agents is a heavier capability than sending a message —
  // gate it behind its own grant so `sendMessage` alone can't launch
  // unbounded subprocesses.
  { method: "POST", pattern: ["tasks", ":tid", "agents"], grant: "spawnAgent" },
  { method: "POST", pattern: ["tasks", ":tid", "continue"], grant: "sendMessage" },
  { method: "POST", pattern: ["tasks", ":tid", "runs", ":sid", "kill"], grant: "sendMessage" },
  // Plan-gate: approve / request-changes / reject the intake plan.
  { method: "POST", pattern: ["tasks", ":tid", "plan", "approve"], grant: "approvePlan" },

  // ── Answer permission popups (grant: answerPermission) ──────────
  { method: "POST", pattern: ["sessions", ":sid", "permission", ":rid"], grant: "answerPermission", checkSession: true },

  // ── Commit / push (grant: commit; push enforced in the route) ───
  { method: "POST", pattern: ["tasks", ":tid", "runs", ":sid", "commit"], grant: "commit" },
  { method: "POST", pattern: ["tasks", ":tid", "runs", ":sid", "commit", "suggest"], grant: "commit" },
];

function splitApiPath(pathname: string): string[] | null {
  // Expect `/api/<...>`; return the decoded segments after `/api/`.
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length < 2 || parts[0] !== "api") return null;
  try {
    return parts.slice(1).map((p) => decodeURIComponent(p));
  } catch {
    return null; // malformed percent-encoding
  }
}

interface MatchCaptures {
  tid?: string;
  sid?: string;
  rid?: string;
}

function matchRule(rule: Rule, segs: string[]): MatchCaptures | null {
  if (rule.pattern.length !== segs.length) return null;
  const caps: MatchCaptures = {};
  for (let i = 0; i < rule.pattern.length; i++) {
    const pat = rule.pattern[i];
    const seg = segs[i];
    if (pat === ":tid") caps.tid = seg;
    else if (pat === ":sid") caps.sid = seg;
    else if (pat === ":rid") caps.rid = seg;
    else if (pat !== seg) return null;
  }
  return caps;
}

/**
 * Decide whether a guest with `scope` may make `method pathname`.
 * Deny-by-default: returns `{ ok: false }` for anything not explicitly
 * allowed, for the wrong task, for a missing grant, or for a session
 * that doesn't belong to the guest's task.
 */
export function authorizeGuestRequest(
  method: string,
  pathname: string,
  scope: GuestScope,
  sessionInTask: SessionInTask,
): GuestAuthResult {
  const m = method.toUpperCase();
  if (m !== "GET" && m !== "POST") return { ok: false, reason: "method not allowed for guest" };
  const segs = splitApiPath(pathname);
  if (!segs) return { ok: false, reason: "not an api path" };

  for (const rule of RULES) {
    if (rule.method !== m) continue;
    const caps = matchRule(rule, segs);
    if (!caps) continue;
    // The task in the path must be the guest's own task.
    if (caps.tid !== undefined && caps.tid !== scope.taskId) {
      return { ok: false, reason: "wrong task" };
    }
    // Required grant (view routes have grant: null).
    if (rule.grant && !scope.grants[rule.grant]) {
      return { ok: false, reason: `missing grant: ${rule.grant}` };
    }
    // Session-direct routes: the session must be a run of the task.
    if (rule.checkSession) {
      if (!caps.sid || !sessionInTask(caps.sid)) {
        return { ok: false, reason: "session not in task" };
      }
    }
    return { ok: true };
  }
  return { ok: false, reason: "not in guest allowlist" };
}

/**
 * Concrete `SessionInTask` predicate: does `sessionId` appear in the
 * task's meta.json runs? Reads through the cached `readMeta`.
 */
export function sessionBelongsToTask(taskId: string, sessionId: string): boolean {
  try {
    const meta = readMeta(join(SESSIONS_DIR, taskId));
    if (!meta) return false;
    return meta.runs.some((r) => r.sessionId === sessionId);
  } catch {
    return false;
  }
}
