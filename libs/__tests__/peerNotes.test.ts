import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function mktmp(): string {
  return mkdtempSync(join(tmpdir(), `bridge-peer-notes-`));
}

describe("peerNotes", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mktmp();
    vi.spyOn(process, "cwd").mockReturnValue(tmpRoot);
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("returns null when notes.md doesn't exist yet (first agent on the task)", async () => {
    const { loadPeerNotes } = await import("../peerNotes");
    expect(loadPeerNotes("t_20260501_001")).toBeNull();
  });

  it("returns null on whitespace-only file", async () => {
    const id = "t_20260501_002";
    const taskDir = join(tmpRoot, "sessions", id);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "notes.md"), "   \n\n   ");
    const { loadPeerNotes } = await import("../peerNotes");
    expect(loadPeerNotes(id)).toBeNull();
  });

  it("loads notes content verbatim", async () => {
    const id = "t_20260501_003";
    const taskDir = join(tmpRoot, "sessions", id);
    mkdirSync(taskDir, { recursive: true });
    const body = [
      "- [planner-api] API uses field `userId` not `user_id`, spec was wrong",
      "- [planner-ui] Refunds page is in apps/center/, not apps/lms/",
    ].join("\n");
    writeFileSync(join(taskDir, "notes.md"), body);
    const { loadPeerNotes } = await import("../peerNotes");
    expect(loadPeerNotes(id)).toBe(body);
  });

  it("appends truncation notice when file exceeds 12 KB cap", async () => {
    const id = "t_20260501_004";
    const taskDir = join(tmpRoot, "sessions", id);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "notes.md"), "x".repeat(16 * 1024));
    const { loadPeerNotes, PEER_NOTES_CAP_BYTES } = await import("../peerNotes");
    const notes = loadPeerNotes(id);
    expect(notes).not.toBeNull();
    expect(notes).toContain("notes.md truncated at 12 KB");
    expect(PEER_NOTES_CAP_BYTES).toBe(12 * 1024);
  });

  it("peerNotesPath builds sessions/<id>/notes.md", async () => {
    const { peerNotesPath } = await import("../peerNotes");
    const p = peerNotesPath("t_20260501_005");
    expect(p.endsWith(join("sessions", "t_20260501_005", "notes.md"))).toBe(true);
  });
});
