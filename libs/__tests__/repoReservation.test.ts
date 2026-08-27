import { beforeEach, describe, expect, it } from "vitest";
import {
  acquireRepoReservation,
  currentReservation,
  releaseRepoReservation,
} from "../repoReservation";

beforeEach(() => {
  releaseRepoReservation("app-a", "s1");
  releaseRepoReservation("app-a", "s2");
  releaseRepoReservation("app-b", "s1");
  releaseRepoReservation("app-b", "s2");
});

describe("repoReservation", () => {
  it("only one session holds a repo at a time", () => {
    expect(acquireRepoReservation("app-a", "s1").ok).toBe(true);
    expect(acquireRepoReservation("app-a", "s2").ok).toBe(false);
  });

  it("releases so the next session can acquire", () => {
    acquireRepoReservation("app-a", "s1");
    releaseRepoReservation("app-a", "s1");
    expect(acquireRepoReservation("app-a", "s2").ok).toBe(true);
  });

  it("a second acquire by the SAME session is idempotent", () => {
    acquireRepoReservation("app-a", "s1");
    expect(acquireRepoReservation("app-a", "s1").ok).toBe(true);
  });

  it("names the holder when it refuses", () => {
    acquireRepoReservation("app-a", "s1");
    expect(acquireRepoReservation("app-a", "s2").heldBy).toBe("s1");
  });

  it("tracks separate repos independently", () => {
    expect(acquireRepoReservation("app-a", "s1").ok).toBe(true);
    expect(acquireRepoReservation("app-b", "s2").ok).toBe(true);
    expect(currentReservation("app-a")?.sessionId).toBe("s1");
    expect(currentReservation("app-b")?.sessionId).toBe("s2");
  });

  it("currentReservation reports null for an unheld repo", () => {
    expect(currentReservation("app-a")).toBeNull();
  });

  it("release by a non-holding session is a safe no-op", () => {
    acquireRepoReservation("app-a", "s1");
    releaseRepoReservation("app-a", "s2");
    expect(currentReservation("app-a")?.sessionId).toBe("s1");
  });

  it("release of an unheld repo is a safe no-op", () => {
    expect(() => releaseRepoReservation("app-a", "s1")).not.toThrow();
    expect(currentReservation("app-a")).toBeNull();
  });
});
