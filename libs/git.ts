import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Read the currently checked-out branch for a working tree without
 * shelling out to `git`. Reads `.git/HEAD` directly:
 *
 *   - `ref: refs/heads/<branch>` → branch name
 *   - bare SHA → "(detached HEAD)"
 *
 * Falls back to `null` if the path isn't a git repo. We don't follow
 * worktrees (`gitdir:` redirection) here — keep it simple, the bridge
 * just wants a label to print.
 */
export function readGitBranch(repoPath: string): string | null {
  const headPath = join(repoPath, ".git", "HEAD");
  if (!existsSync(headPath)) {
    // Worktree pointer: .git is a file with `gitdir: <path>`
    const dotGit = join(repoPath, ".git");
    if (existsSync(dotGit)) {
      try {
        const content = readFileSync(dotGit, "utf8").trim();
        const m = content.match(/^gitdir:\s*(.+)$/);
        if (m) {
          const target = m[1].startsWith("/") || /^[A-Za-z]:/.test(m[1])
            ? m[1]
            : join(repoPath, m[1]);
          const inner = join(target, "HEAD");
          if (existsSync(inner)) return parseHead(readFileSync(inner, "utf8"));
        }
      } catch { /* ignore */ }
    }
    return null;
  }
  try {
    return parseHead(readFileSync(headPath, "utf8"));
  } catch {
    return null;
  }
}

function parseHead(raw: string): string {
  const text = raw.trim();
  const m = text.match(/^ref:\s*refs\/heads\/(.+)$/);
  if (m) return m[1];
  if (/^[0-9a-f]{7,40}$/i.test(text)) return "(detached HEAD)";
  return text;
}
