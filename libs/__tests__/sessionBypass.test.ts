import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetSessionBypassForTests,
  isSessionBypassed,
  setSessionBypass,
} from "../sessionBypass";

const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";

beforeEach(() => _resetSessionBypassForTests());

describe("session bypass flag", () => {
  it("is off until the operator turns it on", () => {
    expect(isSessionBypassed(A)).toBe(false);
  });

  it("turns on for the session it was set on, and only that one", () => {
    setSessionBypass(A, true);
    expect(isSessionBypassed(A)).toBe(true);
    expect(isSessionBypassed(B)).toBe(false);
  });

  it("turns back off, so unticking the box takes effect on the next tool call", () => {
    setSessionBypass(A, true);
    setSessionBypass(A, false);
    expect(isSessionBypassed(A)).toBe(false);
  });

  it("ignores an empty session id rather than creating a catch-all entry", () => {
    setSessionBypass("", true);
    expect(isSessionBypassed("")).toBe(false);
  });
});
