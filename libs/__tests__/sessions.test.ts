import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  pathToSlug,
  tailJsonl,
  tailJsonlBefore,
  listSessions,
  __resetScanHeadCacheForTests,
} from "../sessions";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

describe("pathToSlug", () => {
  it("converts Windows drive path to Claude slug", () => {
    expect(pathToSlug("C:\\projects\\my-bridge")).toBe("C--projects-my-bridge");
  });
  it("collapses dots in folder names (matches Claude's slug)", () => {
    expect(pathToSlug("C:\\projects\\my.app.vn\\my-bridge"))
      .toBe("C--projects-my-app-vn-my-bridge");
  });
  it("converts POSIX path to Claude slug", () => {
    expect(pathToSlug("/home/u/some-app")).toBe("-home-u-some-app");
  });
});

describe("tailJsonl", () => {
  it("returns full content at offset=0 and new offset at EOF", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sess-"));
    const file = join(dir, "s.jsonl");
    writeFileSync(file, `{"a":1}\n{"b":2}\n`);
    const out = await tailJsonl(file, 0);
    expect(out.lines).toEqual([{ a: 1 }, { b: 2 }]);
    expect(out.offset).toBe(16);
    // Each line starts at its byte offset; `{"a":1}\n` is 8 bytes.
    expect(out.lineOffsets).toEqual([0, 8]);
  });

  it("returns only new lines since offset", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sess-"));
    const file = join(dir, "s.jsonl");
    writeFileSync(file, `{"a":1}\n`);
    const first = await tailJsonl(file, 0);
    writeFileSync(file, `{"a":1}\n{"b":2}\n`);
    const second = await tailJsonl(file, first.offset);
    expect(second.lines).toEqual([{ b: 2 }]);
    expect(second.lineOffsets).toEqual([8]);
  });

  it("skips incomplete trailing lines", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sess-"));
    const file = join(dir, "s.jsonl");
    writeFileSync(file, `{"a":1}\n{"b":2`);
    const out = await tailJsonl(file, 0);
    expect(out.lines).toEqual([{ a: 1 }]);
    expect(out.offset).toBe(8);
    expect(out.lineOffsets).toEqual([0]);
  });

  it("offsets stay correct when lines contain multi-byte UTF-8", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sess-"));
    const file = join(dir, "s.jsonl");
    // "Quản lý" is 9 UTF-8 bytes (Q=1, u=1, ả=3, n=1, space=1, l=1, ý=2, =1).
    // Wrapped in `{"v":"Quản lý"}\n`, the line is 18 bytes.
    const line1 = `{"v":"Quản lý"}\n`;
    const line2 = `{"v":"OK"}\n`;
    writeFileSync(file, line1 + line2);
    const out = await tailJsonl(file, 0);
    expect(out.lines).toEqual([{ v: "Quản lý" }, { v: "OK" }]);
    // First line begins at byte 0, second at the byte length of line1.
    expect(out.lineOffsets).toEqual([0, Buffer.byteLength(line1, "utf8")]);
    // Cursor must equal total file size on disk (no drift).
    expect(out.offset).toBe(Buffer.byteLength(line1 + line2, "utf8"));
  });
});

describe("tailJsonl chunked-read parity", () => {
  /**
   * Build a payload bigger than the 256 KB chunk size. Every line is
   * unique JSON so a chunk boundary slipping by a byte would corrupt
   * at least one parsed line and a subsequent assertion would catch it.
   */
  function multiChunkPayload(): { content: string; lineCount: number; sizeBytes: number } {
    const lines: string[] = [];
    // ~600 KB with line lengths in the ~600-1200 byte range.
    for (let i = 0; i < 700; i++) {
      const padding = "x".repeat(800 + (i % 256));
      lines.push(JSON.stringify({ idx: i, payload: padding }));
    }
    const content = lines.join("\n") + "\n";
    return { content, lineCount: lines.length, sizeBytes: Buffer.byteLength(content, "utf8") };
  }

  it("returns the same lines as a direct file read for a multi-chunk file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sess-chunked-"));
    const file = join(dir, "big.jsonl");
    const { content, lineCount, sizeBytes } = multiChunkPayload();
    writeFileSync(file, content);
    expect(sizeBytes).toBeGreaterThan(256 * 1024);

    const out = await tailJsonl(file, 0);
    expect(out.lines.length).toBe(lineCount);
    expect(out.offset).toBe(sizeBytes);
    expect(out.lineOffsets.length).toBe(lineCount);
    // First and last lines parse correctly.
    expect((out.lines[0] as { idx: number }).idx).toBe(0);
    expect((out.lines[lineCount - 1] as { idx: number }).idx).toBe(lineCount - 1);
    // Each line offset matches the actual byte position in the file.
    const direct = readFileSync(file);
    for (let i = 0; i < Math.min(20, lineCount); i++) {
      const start = out.lineOffsets[i]!;
      const end = direct.indexOf(0x0A, start);
      expect(end).toBeGreaterThan(start);
      expect(JSON.parse(direct.subarray(start, end).toString("utf8"))).toEqual(out.lines[i]);
    }
  });

  it("handles a small file under one chunk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sess-chunked-"));
    const file = join(dir, "tiny.jsonl");
    writeFileSync(file, `{"a":1}\n{"b":2}\n{"c":3}\n`);
    const out = await tailJsonl(file, 0);
    expect(out.lines).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
    expect(out.offset).toBe(24);
    expect(out.lineOffsets).toEqual([0, 8, 16]);
  });

  it("trailing partial line is excluded; cursor lands at last newline", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sess-chunked-"));
    const file = join(dir, "partial.jsonl");
    // Final line has no newline — must be skipped.
    writeFileSync(file, `{"a":1}\n{"b":2}\n{"c":noterm`);
    const out = await tailJsonl(file, 0);
    expect(out.lines).toEqual([{ a: 1 }, { b: 2 }]);
    // Cursor should be just after the last `\n` byte (offset 16),
    // NOT at EOF — so the next call resumes at the start of the
    // partial line and re-reads it once it completes.
    expect(out.offset).toBe(16);
  });

  it("survives a multi-byte UTF-8 char straddling a chunk boundary", async () => {
    // Force a 3-byte UTF-8 char ("ả" = 0xE1 0xBA 0xA3) to span the
    // 256 KB chunk edge. We pad with single-byte ASCII up to one
    // less than the chunk size, then start the multi-byte sequence
    // there. The decoder must not corrupt the line.
    const dir = mkdtempSync(join(tmpdir(), "sess-chunked-"));
    const file = join(dir, "boundary.jsonl");
    const CHUNK = 256 * 1024;
    // Build line 1 such that its newline lands BEFORE the chunk
    // boundary, line 2 such that one of its multi-byte chars
    // STRADDLES it.
    // line 1: filler so we cross into chunk 2 partway through line 2.
    const padding1 = "x".repeat(CHUNK - 100);
    const line1 = `{"v":"${padding1}"}\n`;
    // line 2 starts soon after; place "ả" right at the chunk
    // boundary by padding ASCII up to that offset within the line.
    const line1Bytes = Buffer.byteLength(line1, "utf8");
    const offsetInLine2 = CHUNK - line1Bytes;
    const padding2 = "y".repeat(Math.max(0, offsetInLine2 - 6 /* {"v":" */));
    const line2 = `{"v":"${padding2}ảẢý"}\n`;
    const content = line1 + line2;
    writeFileSync(file, content);
    expect(Buffer.byteLength(content, "utf8")).toBeGreaterThan(CHUNK);

    const out = await tailJsonl(file, 0);
    expect(out.lines.length).toBe(2);
    const second = out.lines[1] as { v: string };
    // The decoded line must contain the un-corrupted multi-byte chars.
    expect(second.v.endsWith("ảẢý")).toBe(true);
    expect(out.offset).toBe(Buffer.byteLength(content, "utf8"));
  });

  it("matches direct read when called with a non-zero starting offset", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sess-chunked-"));
    const file = join(dir, "resume.jsonl");
    // 4 short lines, total 32 bytes.
    writeFileSync(file, `{"a":1}\n{"b":2}\n{"c":3}\n{"d":4}\n`);
    const first = await tailJsonl(file, 0);
    expect(first.lines.length).toBe(4);
    // Resume from offset 16 (start of `{"c":3}`) — should yield only
    // the last two lines.
    const second = await tailJsonl(file, 16);
    expect(second.lines).toEqual([{ c: 3 }, { d: 4 }]);
    expect(second.offset).toBe(32);
    expect(second.lineOffsets).toEqual([16, 24]);
  });
});

describe("tailJsonlBefore", () => {
  it("returns lines ending at beforeOffset, starting on a line boundary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sess-"));
    const file = join(dir, "s.jsonl");
    // 3 lines, each 8 bytes → offsets 0, 8, 16, EOF=24.
    writeFileSync(file, `{"a":1}\n{"b":2}\n{"c":3}\n`);
    // Ask for everything before EOF, with a window large enough to fit
    // all of it — should fetch all 3.
    const out = await tailJsonlBefore(file, 24, 1024);
    expect(out.lines).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
    expect(out.fromOffset).toBe(0);
    expect(out.lineOffsets).toEqual([0, 8, 16]);
  });

  it("starts on a line boundary when window mid-record", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sess-"));
    const file = join(dir, "s.jsonl");
    writeFileSync(file, `{"a":1}\n{"b":2}\n{"c":3}\n`);
    // Window of 12 bytes ending at byte 24 → would start at byte 12,
    // mid-record. Helper must skip the partial leading line and pick
    // up at byte 16 (the start of `{"c":3}\n`).
    const out = await tailJsonlBefore(file, 24, 12);
    expect(out.lines).toEqual([{ c: 3 }]);
    expect(out.fromOffset).toBe(16);
    expect(out.lineOffsets).toEqual([16]);
  });

  it("returns empty + fromOffset=0 when beforeOffset is 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sess-"));
    const file = join(dir, "s.jsonl");
    writeFileSync(file, `{"a":1}\n`);
    const out = await tailJsonlBefore(file, 0);
    expect(out.lines).toEqual([]);
    expect(out.fromOffset).toBe(0);
  });
});

describe("listSessions", () => {
  it("hides leaf-pointer stub files that contain only `last-prompt`", () => {
    const dir = mkdtempSync(join(tmpdir(), "sessions-"));
    const stub = join(dir, "stub.jsonl");
    const real = join(dir, "real.jsonl");
    writeFileSync(stub, `{"type":"last-prompt","lastPrompt":"hi","leafUuid":"x","sessionId":"stub"}\n`);
    writeFileSync(real, `{"type":"user","message":{"role":"user","content":"hello"}}\n`);

    const sessions = listSessions(dir);
    expect(sessions.map((s) => s.sessionId)).toEqual(["real"]);
    expect(sessions[0]?.preview).toBe("hello");
  });

  it("keeps assistant-only sessions (no user line yet) but with empty preview", () => {
    const dir = mkdtempSync(join(tmpdir(), "sessions-"));
    const file = join(dir, "asst.jsonl");
    writeFileSync(file, `{"type":"assistant","message":{"role":"assistant","content":"…"}}\n`);
    const sessions = listSessions(dir);
    expect(sessions.map((s) => s.sessionId)).toEqual(["asst"]);
    expect(sessions[0]?.preview).toBe("");
  });

  it("keeps real sessions whose first user line is past the 8 KB head (huge attachment up front)", () => {
    // Reproduces the regression where modern Claude Code transcripts
    // begin with `queue-operation` + a multi-KB `attachment` line, pushing
    // the first user/assistant/summary entry past whatever head-window
    // the scanner was using. The session must still be surfaced.
    const dir = mkdtempSync(join(tmpdir(), "sessions-"));
    const file = join(dir, "huge-head.jsonl");
    const bigBlob = "x".repeat(64 * 1024); // 64 KB attachment payload
    const lines = [
      `{"type":"queue-operation","op":"enqueue"}`,
      `{"type":"attachment","data":"${bigBlob}"}`,
      `{"type":"user","message":{"role":"user","content":"hello past 8KB"}}`,
    ].join("\n") + "\n";
    writeFileSync(file, lines);
    const sessions = listSessions(dir);
    expect(sessions.map((s) => s.sessionId)).toEqual(["huge-head"]);
    expect(sessions[0]?.preview).toBe("hello past 8KB");
  });
});

describe("scanSessionHead cache (via listSessions)", () => {
  // The cache layer is exercised through `listSessions` (the only
  // production caller of `scanSessionHead`). Hits / misses are inferred
  // by mutating the file under controlled (mtime, size) conditions and
  // observing whether the previous result is reused.
  beforeEach(() => {
    __resetScanHeadCacheForTests();
  });

  it("reuses the cached preview when (mtime, size) is unchanged", () => {
    const dir = mkdtempSync(join(tmpdir(), "scan-cache-"));
    const file = join(dir, "real.jsonl");
    // Use two contents of the same byte length so size doesn't shift
    // between writes — cache key changes are scoped to mtime in this
    // test.
    const content1 = `{"type":"user","message":{"role":"user","content":"alpha-text"}}\n`;
    const content2 = `{"type":"user","message":{"role":"user","content":"omega-text"}}\n`;
    expect(Buffer.byteLength(content1, "utf8")).toBe(Buffer.byteLength(content2, "utf8"));
    writeFileSync(file, content1);
    const first = listSessions(dir);
    expect(first[0]?.preview).toBe("alpha-text");

    // Capture mtime + size, then overwrite content but restore both.
    // A cache miss would re-read and pick up content2; a hit returns
    // the cached "alpha-text".
    const st = statSync(file);
    writeFileSync(file, content2);
    utimesSync(file, st.atime, st.mtime);

    const second = listSessions(dir);
    expect(second[0]?.preview).toBe("alpha-text");
  });

  it("misses when mtime changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "scan-cache-"));
    const file = join(dir, "real.jsonl");
    writeFileSync(file, `{"type":"user","message":{"role":"user","content":"alpha"}}\n`);
    expect(listSessions(dir)[0]?.preview).toBe("alpha");

    // Change mtime + content. New mtime → cache miss → fresh preview.
    const st = statSync(file);
    writeFileSync(file, `{"type":"user","message":{"role":"user","content":"beta"}}\n`);
    utimesSync(file, st.atime, new Date(st.mtimeMs + 5000));
    expect(listSessions(dir)[0]?.preview).toBe("beta");
  });

  it("does not cache results for missing files (or files that fail to stat)", () => {
    const dir = mkdtempSync(join(tmpdir(), "scan-cache-"));
    // Empty dir → no sessions.
    expect(listSessions(dir)).toEqual([]);
    // Add a real file. If the prior negative had been cached against
    // some path key it would still appear empty.
    const file = join(dir, "real.jsonl");
    writeFileSync(file, `{"type":"user","message":{"role":"user","content":"now real"}}\n`);
    const out = listSessions(dir);
    expect(out.map((s) => s.sessionId)).toEqual(["real"]);
    expect(out[0]?.preview).toBe("now real");
  });
});

describe("resolveSessionFile", () => {
  // Each test redirects homedir to a fresh temp dir, then re-imports
  // sessions.ts so CLAUDE_PROJECTS_ROOT (captured at module load) points
  // at the temp tree. We mkdir the per-repo project dirs we want to
  // accept and leave others absent to test the existence check.
  let tempHome: string;
  const VALID_SID = "0123abcd-4567-89ef-cdef-0123456789ab";

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "bridge-sessions-test-"));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    vi.spyOn(require("node:os"), "homedir").mockReturnValue(tempHome);
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      rmSync(tempHome, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  function mkProjectDir(repoPath: string): string {
    const dir = join(tempHome, ".claude", "projects", pathToSlug(repoPath));
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  it("resolves to <projects>/<slug>/<sid>.jsonl when the project dir exists", async () => {
    const repo = "/home/u/proj-a";
    const dir = mkProjectDir(repo);
    const { resolveSessionFile } = await import("../sessions");
    const file = resolveSessionFile(repo, VALID_SID);
    expect(file).toBe(join(dir, `${VALID_SID}.jsonl`));
  });

  it("returns null when the project dir does not exist", async () => {
    const { resolveSessionFile } = await import("../sessions");
    expect(resolveSessionFile("/home/u/never-claude-here", VALID_SID)).toBeNull();
  });

  it("returns null for an invalid sessionId", async () => {
    const repo = "/home/u/proj-b";
    mkProjectDir(repo);
    const { resolveSessionFile } = await import("../sessions");
    expect(resolveSessionFile(repo, "not-a-uuid")).toBeNull();
    expect(resolveSessionFile(repo, "")).toBeNull();
    expect(resolveSessionFile(repo, "../etc")).toBeNull();
  });

  it("rejects non-string repo / session inputs", async () => {
    const { resolveSessionFile } = await import("../sessions");
    expect(resolveSessionFile(null, VALID_SID)).toBeNull();
    expect(resolveSessionFile(undefined, VALID_SID)).toBeNull();
    expect(resolveSessionFile(42, VALID_SID)).toBeNull();
    expect(resolveSessionFile("/x", null)).toBeNull();
  });

  it("rejects empty repo, oversize repo, and NUL-byte repo", async () => {
    const { resolveSessionFile } = await import("../sessions");
    expect(resolveSessionFile("", VALID_SID)).toBeNull();
    expect(resolveSessionFile("a".repeat(5000), VALID_SID)).toBeNull();
    expect(resolveSessionFile("/home/u/proj\0evil", VALID_SID)).toBeNull();
  });

  it("rejects probe-by-guess: a `repoPath` whose slug points outside the projects root", async () => {
    // pathToSlug already rewrites separators, but defense-in-depth: if
    // a future change loosened that, the resolved containment check
    // must still reject. We can't easily monkeypatch pathToSlug here,
    // so this test asserts the existence-of-dir guard alone:
    // a path whose slug doesn't correspond to a real dir is rejected.
    const { resolveSessionFile } = await import("../sessions");
    expect(resolveSessionFile("/etc", VALID_SID)).toBeNull();
    expect(resolveSessionFile("../../etc/passwd", VALID_SID)).toBeNull();
    expect(resolveSessionFile("/var/log/secret", VALID_SID)).toBeNull();
  });

  it("does NOT require the .jsonl file itself to exist (caller decides)", async () => {
    // The helper returns the candidate path even when the specific
    // sessionId.jsonl is missing — the route reads with `existsSync`
    // separately and emits an empty result. Only the *project dir*
    // must exist (existence check is the whitelist mechanism).
    const repo = "/home/u/proj-c";
    const dir = mkProjectDir(repo);
    const { resolveSessionFile } = await import("../sessions");
    const file = resolveSessionFile(repo, VALID_SID);
    expect(file).toBe(join(dir, `${VALID_SID}.jsonl`));
  });
});
