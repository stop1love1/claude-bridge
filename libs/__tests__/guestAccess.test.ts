import { describe, expect, it } from "vitest";
import { authorizeGuestRequest, type GuestScope } from "../guestAccess";
import type { ShareGrants } from "../shareStore";

const NONE: ShareGrants = { sendMessage: false, spawnAgent: false, answerPermission: false, commit: false, push: false, approvePlan: false };
const ALL: ShareGrants = { sendMessage: true, spawnAgent: true, answerPermission: true, commit: true, push: true, approvePlan: true };

function scope(grants: ShareGrants, taskId = "t_1"): GuestScope {
  return { taskId, grants };
}

// Default predicate: every session is in the task (we test the session
// gate separately).
const inTask = () => true;
const notInTask = () => false;

describe("authorizeGuestRequest — view baseline (no grant required)", () => {
  it("allows reading the guest's own task meta/summary/usage/events", () => {
    for (const p of ["meta", "summary", "usage", "events"]) {
      expect(authorizeGuestRequest("GET", `/api/tasks/t_1/${p}`, scope(NONE), inTask).ok).toBe(true);
    }
  });

  it("allows run prompt + diff under the task", () => {
    expect(authorizeGuestRequest("GET", "/api/tasks/t_1/runs/sess-9/diff", scope(NONE), inTask).ok).toBe(true);
    expect(authorizeGuestRequest("GET", "/api/tasks/t_1/runs/sess-9/prompt", scope(NONE), inTask).ok).toBe(true);
  });

  it("allows session tail/permission streams only for sessions in the task", () => {
    expect(authorizeGuestRequest("GET", "/api/sessions/sess-9/tail", scope(NONE), inTask).ok).toBe(true);
    expect(authorizeGuestRequest("GET", "/api/sessions/sess-9/tail/stream", scope(NONE), inTask).ok).toBe(true);
    expect(authorizeGuestRequest("GET", "/api/sessions/sess-9/permission/stream", scope(NONE), inTask).ok).toBe(true);
    // Session not in the task → denied even though the route shape matches.
    expect(authorizeGuestRequest("GET", "/api/sessions/sess-9/tail", scope(NONE), notInTask).ok).toBe(false);
  });
});

describe("authorizeGuestRequest — wrong task is always denied", () => {
  it("rejects another task's data", () => {
    const r = authorizeGuestRequest("GET", "/api/tasks/t_OTHER/meta", scope(ALL), inTask);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("wrong task");
  });
});

describe("authorizeGuestRequest — grant gates", () => {
  it("sendMessage gates message/continue/kill/upload", () => {
    const paths: Array<[string, string]> = [
      ["POST", "/api/sessions/sess-9/message"],
      ["POST", "/api/sessions/sess-9/upload"],
      ["POST", "/api/sessions/sess-9/kill"],
      ["POST", "/api/tasks/t_1/continue"],
      ["POST", "/api/tasks/t_1/runs/sess-9/kill"],
    ];
    for (const [m, p] of paths) {
      expect(authorizeGuestRequest(m, p, scope(NONE), inTask).ok).toBe(false);
      expect(authorizeGuestRequest(m, p, scope({ ...NONE, sendMessage: true }), inTask).ok).toBe(true);
    }
  });

  it("spawnAgent (NOT sendMessage) gates the agents-spawn route", () => {
    const p = "/api/tasks/t_1/agents";
    expect(authorizeGuestRequest("POST", p, scope(NONE), inTask).ok).toBe(false);
    // sendMessage alone is no longer enough to spawn agents.
    expect(authorizeGuestRequest("POST", p, scope({ ...NONE, sendMessage: true }), inTask).ok).toBe(false);
    expect(authorizeGuestRequest("POST", p, scope({ ...NONE, spawnAgent: true }), inTask).ok).toBe(true);
  });

  it("answerPermission gates the permission decision POST", () => {
    const p = "/api/sessions/sess-9/permission/req-1";
    expect(authorizeGuestRequest("POST", p, scope(NONE), inTask).ok).toBe(false);
    expect(authorizeGuestRequest("POST", p, scope({ ...NONE, answerPermission: true }), inTask).ok).toBe(true);
  });

  it("commit gates commit + commit/suggest", () => {
    for (const p of ["/api/tasks/t_1/runs/sess-9/commit", "/api/tasks/t_1/runs/sess-9/commit/suggest"]) {
      expect(authorizeGuestRequest("POST", p, scope(NONE), inTask).ok).toBe(false);
      expect(authorizeGuestRequest("POST", p, scope({ ...NONE, commit: true }), inTask).ok).toBe(true);
    }
  });
});

describe("authorizeGuestRequest — deny by default", () => {
  it("rejects dashboard / cross-feature routes even with all grants", () => {
    const denied = [
      ["GET", "/api/apps"],
      ["GET", "/api/tunnels"],
      ["GET", "/api/sessions/all"],
      ["POST", "/api/apps/myapp/exec"],
      ["POST", "/api/apps/myapp/commit"],
      ["GET", "/api/tasks/t_1/runs/sess-9/commit"], // wrong method for a POST-only rule
      ["DELETE", "/api/tasks/t_1/meta"], // method not allowed for guest
      ["PUT", "/api/bridge/settings"],
      ["GET", "/api/usage"],
      ["GET", "/not-an-api/path"],
    ];
    for (const [m, p] of denied) {
      expect(authorizeGuestRequest(m, p, scope(ALL), inTask).ok).toBe(false);
    }
  });

  it("rejects an unknown sub-path under the guest's own task", () => {
    expect(authorizeGuestRequest("POST", "/api/tasks/t_1/clear", scope(ALL), inTask).ok).toBe(false);
    expect(authorizeGuestRequest("DELETE", "/api/tasks/t_1", scope(ALL), inTask).ok).toBe(false);
  });
});
