import { NextResponse } from "next/server";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { resolveRepos } from "@/lib/repos";
import { listSessions, projectDirFor } from "@/lib/sessions";
import { readMeta } from "@/lib/meta";
import { readGitBranch } from "@/lib/git";
import { BRIDGE_MD, BRIDGE_ROOT, SESSIONS_DIR } from "@/lib/paths";

export const dynamic = "force-dynamic";

interface LinkInfo { taskId: string; role: string }

/**
 * Build an index of session-id → {taskId, role} by scanning every
 * sessions/<task-id>/meta.json on disk.
 */
function buildLinkIndex(): Map<string, LinkInfo> {
  const idx = new Map<string, LinkInfo>();
  if (!existsSync(SESSIONS_DIR)) return idx;
  for (const entry of readdirSync(SESSIONS_DIR)) {
    const dir = join(SESSIONS_DIR, entry);
    const meta = readMeta(dir);
    if (!meta) continue;
    for (const run of meta.runs) {
      idx.set(run.sessionId, { taskId: meta.taskId, role: run.role });
    }
  }
  return idx;
}

/**
 * Returns every Claude session under each candidate folder we know about:
 *
 *   - the bridge itself
 *   - every repo declared in BRIDGE.md
 *   - any sibling folder of the bridge that exists on disk
 *
 * That mirrors the discovery logic in `/api/repos`, so the same folders
 * the user can spawn into are also the ones whose sessions show up here.
 * Each entry includes both the short folder name (`repo`) and the full
 * absolute path (`repoPath`) so the UI can group on either.
 */
export function GET() {
  const md = readFileSync(BRIDGE_MD, "utf8");
  const links = buildLinkIndex();

  const seen = new Set<string>();
  const repos: Array<{ name: string; path: string; isBridge: boolean }> = [];
  const push = (name: string, path: string, isBridge: boolean) => {
    if (seen.has(path)) return;
    seen.add(path);
    repos.push({ name, path, isBridge });
  };
  push(basename(BRIDGE_ROOT), BRIDGE_ROOT, true);
  for (const r of resolveRepos(md, BRIDGE_ROOT)) push(r.name, r.path, false);
  try {
    const parent = dirname(BRIDGE_ROOT);
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      push(entry.name, join(parent, entry.name), false);
    }
  } catch { /* parent unreadable */ }

  const out: Array<{
    sessionId: string;
    repo: string;
    repoPath: string;
    branch: string | null;
    isBridge: boolean;
    mtime: number;
    size: number;
    preview: string;
    link: LinkInfo | null;
  }> = [];

  // Cache branch reads — multiple sessions in the same repo only need
  // one .git/HEAD read.
  const branchCache = new Map<string, string | null>();
  const branchOf = (path: string) => {
    if (!branchCache.has(path)) branchCache.set(path, readGitBranch(path));
    return branchCache.get(path) ?? null;
  };

  for (const r of repos) {
    const projectDir = projectDirFor(r.path);
    for (const s of listSessions(projectDir)) {
      out.push({
        sessionId: s.sessionId,
        repo: r.name,
        repoPath: r.path,
        branch: branchOf(r.path),
        isBridge: r.isBridge,
        mtime: s.mtime,
        size: s.size,
        preview: s.preview,
        link: links.get(s.sessionId) ?? null,
      });
    }
  }

  return NextResponse.json(out.sort((a, b) => b.mtime - a.mtime));
}
