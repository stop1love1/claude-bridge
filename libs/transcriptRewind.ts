export interface TruncateResult {
  /** Entries kept, not counting the trailing blank line. */
  kept: number;
  /** Entries dropped, not counting the trailing blank line. */
  dropped: number;
  /** The full file body to write back. */
  payload: string;
}

export interface TruncateOptions {
  /**
   * Keep the entry the uuid points at (the default) — that is a rewind, which
   * lands the session on that message. Pass false to drop it too, which is what
   * editing a message needs: the old turn goes away and the edited one is sent
   * in its place.
   */
  inclusive?: boolean;
}

/**
 * Cuts a Claude Code `.jsonl` transcript at the entry carrying `uuid`.
 * Returns null when no entry matches, so the caller can 404 rather than
 * writing a truncated file.
 */
export function truncateTranscript(
  content: string,
  uuid: string,
  opts: TruncateOptions = {},
): TruncateResult | null {
  const inclusive = opts.inclusive !== false;
  const lines = content.split("\n");

  let cutoff = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]) continue;
    try {
      const obj = JSON.parse(lines[i]) as { uuid?: string };
      if (obj.uuid === uuid) {
        cutoff = i;
        break;
      }
    } catch {
      // A half-written line is not the one we are looking for.
    }
  }
  if (cutoff === -1) return null;

  const keepCount = inclusive ? cutoff + 1 : cutoff;
  const keptLines = lines.slice(0, keepCount).filter((l) => l.length > 0);
  const droppedLines = lines.slice(keepCount).filter((l) => l.length > 0);
  const joined = keptLines.join("\n");

  return {
    kept: keptLines.length,
    dropped: droppedLines.length,
    payload: joined ? joined + "\n" : "",
  };
}
