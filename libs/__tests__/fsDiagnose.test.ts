import { describe, expect, it } from "vitest";
import { describeWriteFailure, errnoCode, writeFailureHint } from "../fsDiagnose";

const BRIDGE_JSON = "/home/dev/.claude/bridge.json";
const CLAUDE_DIR = "/home/dev/.claude";

function errnoError(code: string): NodeJS.ErrnoException {
  const err = new Error(`${code}: permission denied, open '${BRIDGE_JSON}'`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

/** Builds a POSIX deps stub where each path maps to `uid:gid` + octal mode. */
function posixDeps(
  table: Record<string, { uid: number; gid: number; mode: number }>,
  self: { uid: number; gid: number } = { uid: 1000, gid: 1000 },
) {
  return {
    platform: "linux" as NodeJS.Platform,
    statSync: (p: string) => {
      const hit = table[p];
      if (!hit) {
        const err = new Error(`ENOENT: no such file '${p}'`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return hit;
    },
    getuid: () => self.uid,
    getgid: () => self.gid,
  };
}

describe("errnoCode", () => {
  it("reads the code off an errno error", () => {
    expect(errnoCode(errnoError("EACCES"))).toBe("EACCES");
  });

  it("returns null for anything without a string code", () => {
    expect(errnoCode(new Error("plain"))).toBeNull();
    expect(errnoCode(null)).toBeNull();
    expect(errnoCode(undefined)).toBeNull();
    expect(errnoCode("EACCES")).toBeNull();
    expect(errnoCode({ code: 13 })).toBeNull();
  });
});

describe("describeWriteFailure — the sudo-looking Linux cases", () => {
  it("names the root-owned parent directory and the exact chown that fixes it", () => {
    const msg = describeWriteFailure(
      BRIDGE_JSON,
      errnoError("EACCES"),
      posixDeps({ [CLAUDE_DIR]: { uid: 0, gid: 0, mode: 0o755 } }),
    );
    expect(msg).toContain("EACCES");
    expect(msg).toContain(CLAUDE_DIR);
    expect(msg).toContain("owned by 0:0");
    expect(msg).toContain("runs as 1000:1000");
    expect(msg).toContain(`sudo chown -R 1000:1000 ${CLAUDE_DIR}`);
  });

  it("names the root-owned file when the directory itself is fine", () => {
    const msg = describeWriteFailure(
      BRIDGE_JSON,
      errnoError("EACCES"),
      posixDeps({
        [CLAUDE_DIR]: { uid: 1000, gid: 1000, mode: 0o700 },
        [BRIDGE_JSON]: { uid: 0, gid: 0, mode: 0o600 },
      }),
    );
    expect(msg).toContain("owned by 0:0");
    expect(msg).toContain(`sudo chown 1000:1000 ${BRIDGE_JSON}`);
    expect(msg).not.toContain("-R");
  });

  it("blames the mode, not the owner, when the directory is ours but not writable", () => {
    const msg = describeWriteFailure(
      BRIDGE_JSON,
      errnoError("EACCES"),
      posixDeps({ [CLAUDE_DIR]: { uid: 1000, gid: 1000, mode: 0o500 } }),
    );
    expect(msg).toContain("0500");
    expect(msg).toContain(`chmod u+rwx ${CLAUDE_DIR}`);
    expect(msg).not.toContain("chown");
  });

  it("blames the file mode when the file is ours but read-only", () => {
    const msg = describeWriteFailure(
      BRIDGE_JSON,
      errnoError("EACCES"),
      posixDeps({
        [CLAUDE_DIR]: { uid: 1000, gid: 1000, mode: 0o700 },
        [BRIDGE_JSON]: { uid: 1000, gid: 1000, mode: 0o400 },
      }),
    );
    expect(msg).toContain("0400");
    expect(msg).toContain(`chmod u+w ${BRIDGE_JSON}`);
  });

  it("points past POSIX bits (ACL / SELinux / container uid) when ownership and modes look fine", () => {
    const msg = describeWriteFailure(
      BRIDGE_JSON,
      errnoError("EACCES"),
      posixDeps({
        [CLAUDE_DIR]: { uid: 1000, gid: 1000, mode: 0o700 },
        [BRIDGE_JSON]: { uid: 1000, gid: 1000, mode: 0o600 },
      }),
    );
    expect(msg).toContain("getfacl");
    expect(msg).toContain("SELinux");
  });

  it("reports an unreadable parent directory instead of pretending to know the owner", () => {
    const msg = describeWriteFailure(
      BRIDGE_JSON,
      errnoError("EACCES"),
      posixDeps({}),
    );
    expect(msg).toContain(CLAUDE_DIR);
    expect(msg).toContain("cannot be read");
  });
});

describe("describeWriteFailure — non-permission and non-POSIX cases", () => {
  it("calls out a read-only mount", () => {
    const msg = describeWriteFailure(BRIDGE_JSON, errnoError("EROFS"), posixDeps({}));
    expect(msg).toContain("read-only");
    expect(msg).not.toContain("chown");
  });

  it("calls out a full disk", () => {
    const msg = describeWriteFailure(BRIDGE_JSON, errnoError("ENOSPC"), posixDeps({}));
    expect(msg).toContain("full");
  });

  it("does not invent a POSIX story for an unrelated errno", () => {
    const msg = describeWriteFailure(BRIDGE_JSON, errnoError("EISDIR"), posixDeps({}));
    expect(msg).toContain("EISDIR");
    expect(msg).not.toContain("chown");
    expect(msg).not.toContain("uid");
  });

  it("falls back to a Windows-shaped explanation when there is no uid", () => {
    const msg = describeWriteFailure(
      "D:\\projects\\bridge.json",
      errnoError("EPERM"),
      { platform: "win32", getuid: undefined, getgid: undefined },
    );
    expect(msg).toContain("EPERM");
    expect(msg).toContain("another process");
    expect(msg).not.toContain("chown");
  });

  it("survives an error with no code at all", () => {
    const msg = describeWriteFailure(BRIDGE_JSON, new Error("boom"), posixDeps({}));
    expect(msg).toContain(BRIDGE_JSON);
  });
});

describe("writeFailureHint — the path-free message the API is allowed to return", () => {
  it("maps the permission codes to an actionable, path-free sentence", () => {
    for (const code of ["EACCES", "EPERM"]) {
      const hint = writeFailureHint("~/.claude/bridge.json", errnoError(code));
      expect(hint).toContain(code);
      expect(hint).toContain("~/.claude/bridge.json");
      expect(hint).toContain("permission");
    }
  });

  it("maps EROFS and ENOSPC to their own causes", () => {
    expect(writeFailureHint("~/.claude/bridge.json", errnoError("EROFS"))).toContain("read-only");
    expect(writeFailureHint("~/.claude/bridge.json", errnoError("ENOSPC"))).toContain("full");
  });

  it("returns null for errors that are not about writability", () => {
    expect(writeFailureHint("~/.claude/bridge.json", errnoError("EISDIR"))).toBeNull();
    expect(writeFailureHint("~/.claude/bridge.json", new Error("boom"))).toBeNull();
  });

  it("never leaks an absolute host path", () => {
    const hint = writeFailureHint("~/.claude/bridge.json", errnoError("EACCES")) ?? "";
    expect(hint).not.toContain("/home/dev");
  });
});
