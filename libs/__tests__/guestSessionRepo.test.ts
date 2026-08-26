import { describe, expect, it } from "vitest";
import { guestBoundRepoValue } from "../guestSessionRepo";

describe("guestBoundRepoValue", () => {
  it("ignores a guest's caller-supplied value and uses the session's own recorded value", () => {
    expect(
      guestBoundRepoValue({ actorKind: "guest", callerValue: "app-b", sessionValue: "app-a" }),
    ).toBe("app-a");
  });

  it("denies a guest when the session has no recorded value to bind to", () => {
    expect(
      guestBoundRepoValue({ actorKind: "guest", callerValue: "app-b", sessionValue: null }),
    ).toBe(null);
  });

  it("preserves the operator's caller-supplied value even when it differs from the session record", () => {
    expect(
      guestBoundRepoValue({ actorKind: "operator", callerValue: "app-b", sessionValue: "app-a" }),
    ).toBe("app-b");
  });

  it("preserves the operator's caller-supplied value when there is no session record at all (free chat)", () => {
    expect(
      guestBoundRepoValue({ actorKind: "operator", callerValue: "app-b", sessionValue: null }),
    ).toBe("app-b");
  });
});
