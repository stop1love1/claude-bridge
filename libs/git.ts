import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function readGitBranch(repoPath: string): string | null {
  const headPath = join(repoPath, ".git", "HEAD");
  if (!existsSync(headPath)) {
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
      } catch { }
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
