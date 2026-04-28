import { describe, it, expect } from "vitest";
import { pathToSlug, tailJsonl, tailJsonlBefore, findSessionByPrefix, listSessions } from "../sessions";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
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
});

describe("findSessionByPrefix", () => {
  it("finds the newest .jsonl whose first user message starts with prefix", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sessions-"));
    const old = join(dir, "old.jsonl");
    const neu = join(dir, "new.jsonl");
    const other = join(dir, "other.jsonl");
    writeFileSync(old, `{"type":"user","message":{"role":"user","content":"[ROLE: coder] [TASK: t_20260424_001] hi"}}\n`);
    writeFileSync(neu, `{"type":"user","message":{"role":"user","content":"[ROLE: coder] [TASK: t_20260424_001] hi"}}\n`);
    writeFileSync(other, `{"type":"user","message":{"role":"user","content":"[ROLE: reviewer] [TASK: t_20260424_001] hi"}}\n`);
    utimesSync(old, Date.now() / 1000 - 100, Date.now() / 1000 - 100);

    const match = await findSessionByPrefix(dir, "[ROLE: coder] [TASK: t_20260424_001]");
    expect(match).toBe(neu);
  });
});
