import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SESSIONS_DIR } from "./paths";

export const PEER_NOTES_CAP_BYTES = 12 * 1024;

export function peerNotesPath(taskId: string): string {
  return join(SESSIONS_DIR, taskId, "notes.md");
}

export function loadPeerNotes(taskId: string): string | null {
  const p = peerNotesPath(taskId);
  if (!existsSync(p)) return null;
  try {
    const buf = readFileSync(p);
    const text = buf
      .subarray(0, PEER_NOTES_CAP_BYTES)
      .toString("utf8")
      .trim();
    if (text.length === 0) return null;
    if (buf.byteLength > PEER_NOTES_CAP_BYTES) {
      return (
        text +
        "\n\n…(bridge: notes.md truncated at 12 KB cap — older entries are still on disk; read the file directly if you need them)"
      );
    }
    return text;
  } catch {
    return null;
  }
}
