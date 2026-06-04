import { describe, it, expect } from "vitest";
import { authorizeGuestRequest, type GuestScope } from "../guestAccess";
import type { ShareGrants } from "../shareStore";

const tid = "t_20260604_001";
const grantsAll: ShareGrants = {
  sendMessage: true, spawnAgent: true, answerPermission: true,
  commit: false, push: false, approvePlan: true, viewPreview: true,
};
const grantsNoApprove: ShareGrants = { ...grantsAll, approvePlan: false };
const scope = (grants: ShareGrants): GuestScope => ({ taskId: tid, grants });
const noop = () => true;

describe("guest plan-gate routes", () => {
  it("any task guest may GET the plan (view baseline)", () => {
    const r = authorizeGuestRequest("GET", `/api/tasks/${tid}/plan`, scope(grantsNoApprove), noop);
    expect(r.ok).toBe(true);
  });

  it("approve requires the approvePlan grant", () => {
    expect(authorizeGuestRequest("POST", `/api/tasks/${tid}/plan/approve`, scope(grantsAll), noop).ok).toBe(true);
    const denied = authorizeGuestRequest("POST", `/api/tasks/${tid}/plan/approve`, scope(grantsNoApprove), noop);
    expect(denied.ok).toBe(false);
    expect(denied.reason).toMatch(/approvePlan/);
  });

  it("approve on a different task is rejected", () => {
    const r = authorizeGuestRequest("POST", `/api/tasks/t_other_999/plan/approve`, scope(grantsAll), noop);
    expect(r.ok).toBe(false);
  });

  it("GET preview requires the viewPreview grant", () => {
    expect(authorizeGuestRequest("GET", `/api/tasks/${tid}/preview`, scope(grantsAll), noop).ok).toBe(true);
    const denied = authorizeGuestRequest("GET", `/api/tasks/${tid}/preview`, scope({ ...grantsAll, viewPreview: false }), noop);
    expect(denied.ok).toBe(false);
    expect(denied.reason).toMatch(/viewPreview/);
  });

  it("presence GET + POST are view-baseline (no grant needed) but task-scoped", () => {
    const noGrants = scope({ ...grantsAll, viewPreview: false, approvePlan: false });
    expect(authorizeGuestRequest("GET", `/api/tasks/${tid}/presence`, noGrants, noop).ok).toBe(true);
    expect(authorizeGuestRequest("POST", `/api/tasks/${tid}/presence`, noGrants, noop).ok).toBe(true);
    expect(authorizeGuestRequest("POST", `/api/tasks/t_other_999/presence`, noGrants, noop).ok).toBe(false);
  });
});
