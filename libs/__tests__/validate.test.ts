import { describe, expect, it } from "vitest";
import {
  badRequest,
  isValidAgentRole,
  isValidPermissionMode,
  isValidRepoLabel,
  isValidRequestId,
  isValidRunStatus,
  isValidSessionId,
  isValidToolName,
} from "../validate";

const VALID_UUID = "0123abcd-4567-89ef-cdef-0123456789ab";
const VALID_UUID_UPPER = "0123ABCD-4567-89EF-CDEF-0123456789AB";

const TRAVERSAL_INPUTS = [
  "../etc/passwd",
  "..\\windows\\system32",
  "/etc/passwd",
  "C:\\Windows",
  "foo/bar",
  "foo\\bar",
  "foo\0bar",
  "foo bar",
  "foo:bar",
  "foo*",
  "foo?",
];

const NON_STRING_INPUTS: unknown[] = [
  undefined,
  null,
  0,
  1,
  true,
  false,
  {},
  [],
  Symbol("x"),
  () => "x",
];

describe("isValidSessionId", () => {
  it("accepts UUID v4-ish strings (lower + upper case)", () => {
    expect(isValidSessionId(VALID_UUID)).toBe(true);
    expect(isValidSessionId(VALID_UUID_UPPER)).toBe(true);
  });

  it("rejects empty / wrong-shape strings", () => {
    expect(isValidSessionId("")).toBe(false);
    expect(isValidSessionId("abc")).toBe(false);
    expect(isValidSessionId(VALID_UUID + "x")).toBe(false);
    expect(isValidSessionId(VALID_UUID.replace(/-/g, ""))).toBe(false);
    expect(isValidSessionId("zzzzzzzz-4567-89ef-cdef-0123456789ab")).toBe(
      false,
    );
  });

  it("rejects path-traversal payloads", () => {
    for (const p of TRAVERSAL_INPUTS) expect(isValidSessionId(p)).toBe(false);
    expect(isValidSessionId(`../${VALID_UUID}`)).toBe(false);
    expect(isValidSessionId(`${VALID_UUID}/..`)).toBe(false);
  });

  it("rejects non-string inputs", () => {
    for (const v of NON_STRING_INPUTS) expect(isValidSessionId(v)).toBe(false);
  });
});

describe("isValidRequestId", () => {
  it("accepts a UUID", () => {
    expect(isValidRequestId(VALID_UUID)).toBe(true);
  });
  it("rejects garbage / non-strings", () => {
    expect(isValidRequestId("nope")).toBe(false);
    expect(isValidRequestId(null)).toBe(false);
    expect(isValidRequestId(undefined)).toBe(false);
    expect(isValidRequestId(42)).toBe(false);
  });
});

describe("isValidAgentRole", () => {
  it("accepts standard role labels", () => {
    expect(isValidAgentRole("coordinator")).toBe(true);
    expect(isValidAgentRole("coder")).toBe(true);
    expect(isValidAgentRole("doc-writer")).toBe(true);
    expect(isValidAgentRole("agent_42")).toBe(true);
    expect(isValidAgentRole("v1.2")).toBe(true);
    expect(isValidAgentRole("a")).toBe(true);
    expect(isValidAgentRole("a".repeat(64))).toBe(true);
  });

  it("rejects empty / over-long / wrong-charset", () => {
    expect(isValidAgentRole("")).toBe(false);
    expect(isValidAgentRole("a".repeat(65))).toBe(false);
    expect(isValidAgentRole("has space")).toBe(false);
    expect(isValidAgentRole("slash/role")).toBe(false);
    expect(isValidAgentRole("back\\slash")).toBe(false);
    expect(isValidAgentRole("nul\0byte")).toBe(false);
    expect(isValidAgentRole("../traverse")).toBe(false);
    expect(isValidAgentRole("tab\tchar")).toBe(false);
    expect(isValidAgentRole("emoji-\u{1F600}")).toBe(false);
  });

  it("rejects path-traversal payloads", () => {
    for (const p of TRAVERSAL_INPUTS) expect(isValidAgentRole(p)).toBe(false);
  });

  it("rejects non-string inputs", () => {
    for (const v of NON_STRING_INPUTS) expect(isValidAgentRole(v)).toBe(false);
  });
});

describe("isValidRepoLabel", () => {
  it("accepts repo-style labels", () => {
    expect(isValidRepoLabel("edusoft-lms-bridge")).toBe(true);
    expect(isValidRepoLabel("Some_Repo.v2")).toBe(true);
  });
  it("rejects traversal + bad chars + non-strings", () => {
    expect(isValidRepoLabel("")).toBe(false);
    expect(isValidRepoLabel("../foo")).toBe(false);
    expect(isValidRepoLabel("foo/bar")).toBe(false);
    for (const v of NON_STRING_INPUTS) expect(isValidRepoLabel(v)).toBe(false);
  });
});

describe("isValidToolName", () => {
  it("accepts known tool labels", () => {
    expect(isValidToolName("Bash")).toBe(true);
    expect(isValidToolName("spawn_agent")).toBe(true);
    expect(isValidToolName("mcp.tool-name")).toBe(true);
  });
  it("rejects empty / bad chars / non-strings", () => {
    expect(isValidToolName("")).toBe(false);
    expect(isValidToolName("foo bar")).toBe(false);
    expect(isValidToolName("foo/bar")).toBe(false);
    for (const v of NON_STRING_INPUTS) expect(isValidToolName(v)).toBe(false);
  });
});

describe("isValidRunStatus", () => {
  it("accepts the documented enum", () => {
    expect(isValidRunStatus("queued")).toBe(true);
    expect(isValidRunStatus("running")).toBe(true);
    expect(isValidRunStatus("done")).toBe(true);
    expect(isValidRunStatus("failed")).toBe(true);
    expect(isValidRunStatus("stale")).toBe(true);
  });
  it("rejects anything else", () => {
    expect(isValidRunStatus("")).toBe(false);
    expect(isValidRunStatus("RUNNING")).toBe(false);
    expect(isValidRunStatus("pending")).toBe(false);
    expect(isValidRunStatus("../etc/passwd")).toBe(false);
    for (const v of NON_STRING_INPUTS) expect(isValidRunStatus(v)).toBe(false);
  });
});

describe("isValidPermissionMode", () => {
  it("accepts every documented `claude --permission-mode` value", () => {
    for (const mode of [
      "default",
      "acceptEdits",
      "plan",
      "auto",
      "bypassPermissions",
      "dontAsk",
    ]) {
      expect(isValidPermissionMode(mode)).toBe(true);
    }
  });

  it("rejects unknown / case-mismatched / empty inputs", () => {
    expect(isValidPermissionMode("")).toBe(false);
    expect(isValidPermissionMode("BYPASSPERMISSIONS")).toBe(false);
    expect(isValidPermissionMode("bypass")).toBe(false);
    expect(isValidPermissionMode("readOnly")).toBe(false);
    expect(isValidPermissionMode("../etc/passwd")).toBe(false);
  });

  it("rejects non-string inputs", () => {
    for (const v of NON_STRING_INPUTS) {
      expect(isValidPermissionMode(v)).toBe(false);
    }
  });
});

describe("badRequest", () => {
  it("returns a 400 NextResponse with the supplied message", async () => {
    const res = badRequest("nope");
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("nope");
  });
});
