
import { join } from "node:path";
import { readMeta } from "./meta";
import { SESSIONS_DIR } from "./paths";
import type { ShareGrants } from "./shareStore";

export interface GuestScope {
  taskId: string;
  grants: ShareGrants;
}

export type SessionInTask = (sessionId: string) => boolean;

export interface GuestAuthResult {
  ok: boolean;
  reason?: string;
}

type GrantKey = keyof ShareGrants;

interface Rule {
  method: "GET" | "POST";
  pattern: string[];
  grant: GrantKey | null;
  checkSession?: boolean;
}

const RULES: Rule[] = [
  { method: "GET", pattern: ["tasks", ":tid", "meta"], grant: null },
  { method: "GET", pattern: ["tasks", ":tid", "summary"], grant: null },
  { method: "GET", pattern: ["tasks", ":tid", "usage"], grant: null },
  { method: "GET", pattern: ["tasks", ":tid", "events"], grant: null },
  { method: "GET", pattern: ["tasks", ":tid", "runs", ":sid", "prompt"], grant: null },
  { method: "GET", pattern: ["tasks", ":tid", "runs", ":sid", "diff"], grant: null },
  { method: "GET", pattern: ["tasks", ":tid", "plan"], grant: null },
  { method: "GET", pattern: ["tasks", ":tid", "preview"], grant: "viewPreview" },
  { method: "GET", pattern: ["tasks", ":tid", "presence"], grant: null },
  { method: "POST", pattern: ["tasks", ":tid", "presence"], grant: null },
  { method: "GET", pattern: ["sessions", ":sid", "tail"], grant: null, checkSession: true },
  { method: "GET", pattern: ["sessions", ":sid", "tail", "stream"], grant: null, checkSession: true },
  { method: "GET", pattern: ["sessions", ":sid", "permission"], grant: null, checkSession: true },
  { method: "GET", pattern: ["sessions", ":sid", "permission", "stream"], grant: null, checkSession: true },

  { method: "POST", pattern: ["sessions", ":sid", "message"], grant: "sendMessage", checkSession: true },
  { method: "POST", pattern: ["sessions", ":sid", "upload"], grant: "sendMessage", checkSession: true },
  { method: "POST", pattern: ["sessions", ":sid", "kill"], grant: "sendMessage", checkSession: true },
  { method: "POST", pattern: ["tasks", ":tid", "agents"], grant: "spawnAgent" },
  { method: "POST", pattern: ["tasks", ":tid", "continue"], grant: "sendMessage" },
  { method: "POST", pattern: ["tasks", ":tid", "runs", ":sid", "kill"], grant: "sendMessage" },
  { method: "POST", pattern: ["tasks", ":tid", "plan", "approve"], grant: "approvePlan" },

  { method: "POST", pattern: ["sessions", ":sid", "permission", ":rid"], grant: "answerPermission", checkSession: true },

  { method: "POST", pattern: ["tasks", ":tid", "runs", ":sid", "commit"], grant: "commit" },
  { method: "POST", pattern: ["tasks", ":tid", "runs", ":sid", "commit", "suggest"], grant: "commit" },
];

function splitApiPath(pathname: string): string[] | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length < 2 || parts[0] !== "api") return null;
  try {
    return parts.slice(1).map((p) => decodeURIComponent(p));
  } catch {
    return null;
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
    if (caps.tid !== undefined && caps.tid !== scope.taskId) {
      return { ok: false, reason: "wrong task" };
    }
    if (rule.grant && !scope.grants[rule.grant]) {
      return { ok: false, reason: `missing grant: ${rule.grant}` };
    }
    if (rule.checkSession) {
      if (!caps.sid || !sessionInTask(caps.sid)) {
        return { ok: false, reason: "session not in task" };
      }
    }
    return { ok: true };
  }
  return { ok: false, reason: "not in guest allowlist" };
}

export function sessionBelongsToTask(taskId: string, sessionId: string): boolean {
  try {
    const meta = readMeta(join(SESSIONS_DIR, taskId));
    if (!meta) return false;
    return meta.runs.some((r) => r.sessionId === sessionId);
  } catch {
    return false;
  }
}
