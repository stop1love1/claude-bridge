import { describe, it, expect } from "vitest";
import {
  classifyHost,
  parseDevopsVerdict,
  parseRemoteHost,
} from "../devops";

describe("parseRemoteHost", () => {
  it("extracts host from https URLs", () => {
    expect(parseRemoteHost("https://github.com/owner/repo.git")).toBe("github.com");
    expect(parseRemoteHost("https://gitlab.com/owner/repo")).toBe("gitlab.com");
    expect(parseRemoteHost("https://git.acme.io/team/repo.git")).toBe("git.acme.io");
  });

  it("extracts host from ssh URLs", () => {
    expect(parseRemoteHost("git@github.com:owner/repo.git")).toBe("github.com");
    expect(parseRemoteHost("git@gitlab.example.com:owner/repo.git")).toBe("gitlab.example.com");
    // Custom user prefix.
    expect(parseRemoteHost("deploy@host.local:org/repo.git")).toBe("host.local");
  });

  it("lowercases hosts so case mismatches don't fool classify", () => {
    expect(parseRemoteHost("https://GitHub.COM/owner/repo")).toBe("github.com");
  });

  it("returns null for unparseable input", () => {
    expect(parseRemoteHost("")).toBe(null);
    expect(parseRemoteHost("not a url")).toBe(null);
    expect(parseRemoteHost("   ")).toBe(null);
  });
});

describe("classifyHost", () => {
  it("recognizes github.com explicitly", () => {
    expect(classifyHost("github.com")).toBe("github");
  });

  it("recognizes gitlab.com explicitly and self-hosted gitlab subdomains", () => {
    expect(classifyHost("gitlab.com")).toBe("gitlab");
    expect(classifyHost("gitlab.acme.io")).toBe("gitlab");
    expect(classifyHost("gitlab.example.com")).toBe("gitlab");
  });

  it("falls back to unknown for self-hosted that doesn't name itself", () => {
    expect(classifyHost("git.acme.io")).toBe("unknown");
    expect(classifyHost("code.example.org")).toBe("unknown");
  });

  it("does not match hostnames that merely contain `gitlab` as a substring", () => {
    // Regression: a naive `host.includes("gitlab")` would route any of
    // these to glab and then fail because the protocol disagrees.
    expect(classifyHost("notgitlab.internal")).toBe("unknown");
    expect(classifyHost("gitlab-archive.com")).toBe("unknown");
    expect(classifyHost("mygitlab.example.org")).toBe("unknown");
    // But a real label like `gitlab.acme.io` still matches.
    expect(classifyHost("gitlab.acme.io")).toBe("gitlab");
    expect(classifyHost("internal.gitlab.acme.io")).toBe("gitlab");
  });
});

describe("parseDevopsVerdict", () => {
  it("accepts a well-formed `opened` verdict", () => {
    const v = parseDevopsVerdict({
      status: "opened",
      url: "https://github.com/o/r/pull/42",
      cli: "gh",
      reason: "fresh PR",
    });
    expect(v).toEqual({
      status: "opened",
      url: "https://github.com/o/r/pull/42",
      cli: "gh",
      reason: "fresh PR",
    });
  });

  it("accepts `exists` with a url and `skipped` without one", () => {
    expect(parseDevopsVerdict({
      status: "exists",
      url: "https://gitlab.com/o/r/-/merge_requests/3",
      cli: "glab",
      reason: "MR already open",
    })?.status).toBe("exists");

    expect(parseDevopsVerdict({
      status: "skipped",
      url: null,
      cli: "gh",
      reason: "auth missing",
    })?.url).toBe(null);
  });

  it("rejects unknown status / cli values", () => {
    expect(parseDevopsVerdict({ status: "merged", url: null, cli: "gh", reason: "" })).toBe(null);
    expect(parseDevopsVerdict({ status: "opened", url: null, cli: "hub", reason: "" })).toBe(null);
  });

  it("rejects non-objects and missing fields", () => {
    expect(parseDevopsVerdict(null)).toBe(null);
    expect(parseDevopsVerdict("opened")).toBe(null);
    expect(parseDevopsVerdict({ status: "opened" })).toBe(null);
  });

  it("supplies a fallback reason when one isn't provided", () => {
    const v = parseDevopsVerdict({ status: "skipped", url: null, cli: "gh", reason: "" });
    expect(v?.reason).toBe("(no reason provided)");
  });
});
