import { describe, expect, it } from "vitest";
import { guestMayTargetRepo } from "../guestRepoBinding";

describe("guestMayTargetRepo", () => {
  it("lets a guest spawn into the app their task is pinned to", () => {
    expect(guestMayTargetRepo({ actorKind: "guest", repo: "app-a", taskApp: "app-a" })).toBe(true);
  });

  it("blocks a guest spawning into a different registered app", () => {
    expect(guestMayTargetRepo({ actorKind: "guest", repo: "app-b", taskApp: "app-a" })).toBe(false);
  });

  it("blocks a guest when the task is not pinned to any app", () => {
    expect(guestMayTargetRepo({ actorKind: "guest", repo: "app-a", taskApp: null })).toBe(false);
  });

  it("does not restrict the operator", () => {
    expect(guestMayTargetRepo({ actorKind: "operator", repo: "app-b", taskApp: "app-a" })).toBe(true);
  });
});
