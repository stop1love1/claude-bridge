import { describe, expect, it } from "vitest";
import { checkBlocklist, filterPtyStdinChunk } from "../appExecGuard";

describe("checkBlocklist", () => {
  it("allows benign git status", () => {
    expect(checkBlocklist("git status").ok).toBe(true);
  });

  it("blocks sudo", () => {
    const r = checkBlocklist("sudo apt update");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("sudo");
  });

  it("blocks dd to a disk device", () => {
    const r = checkBlocklist("dd if=/dev/zero of=/dev/sda bs=1M");
    expect(r.ok).toBe(false);
  });

  it("allows dd to /dev/null", () => {
    expect(checkBlocklist("dd if=/dev/zero of=/dev/null count=1").ok).toBe(true);
  });

  it("blocks /etc/shadow reference", () => {
    const r = checkBlocklist("cat /etc/shadow");
    expect(r.ok).toBe(false);
  });
});

describe("filterPtyStdinChunk", () => {
  it("blocks when pattern completes across chunks", () => {
    const st = { buf: "" };
    expect(filterPtyStdinChunk(st, "sudo").ok).toBe(true);
    const r = filterPtyStdinChunk(st, " ls\n");
    expect(r.ok).toBe(false);
  });

  it("clears buffer after block", () => {
    const st = { buf: "" };
    expect(filterPtyStdinChunk(st, "sudo").ok).toBe(true);
    const r = filterPtyStdinChunk(st, " ls");
    expect(r.ok).toBe(false);
    expect(st.buf).toBe("");
  });
});
