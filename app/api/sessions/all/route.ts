import { NextResponse } from "next/server";
import { readdirSync, existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { resolveRepos } from "@/libs/repos";
import { discoverOrphanProjects, listSessions, projectDirFor } from "@/libs/sessions";
import { readMeta, subscribeMetaAll } from "@/libs/meta";
import { readGitBranch } from "@/libs/git";
import { BRIDGE_ROOT, SESSIONS_DIR, readBridgeMd } from "@/libs/paths";
import { setSessionsListBuster } from "@/libs/sessionListCache";

export const dynamic = "force-dynamic";

type SessionRow = {
  sessionId: string;
  repo: string;
  repoPath: string;
  branch: string | null;
  isBridge: boolean;
  mtime: number;
  size: number;
  preview: string;
  link: LinkInfo | null;
};
const RESPONSE_TTL_MS = 2000;
let responseCache: { value: SessionRow[]; expires: number } | null = null;

// global registries. HMR-safe via the underlying EventEmitter stash.
const G = globalThis as unknown as { __bridgeSessionsAllSub?: boolean };
if (!G.__bridgeSessionsAllSub) {
  G.__bridgeSessionsAllSub = true;
  subscribeMetaAll(() => { responseCache = null; });
}
setSessionsListBuster(() => { responseCache = null; });

interface LinkInfo { taskId: string; role: string }

function buildLinkIndex(): { links: Map<string, LinkInfo>; taskTitles: Map<string, string> } {
  const links = new Map<string, LinkInfo>();
  const taskTitles = new Map<string, string>();
  if (!existsSync(SESSIONS_DIR)) return { links, taskTitles };
  for (const entry of readdirSync(SESSIONS_DIR)) {
    const dir = join(SESSIONS_DIR, entry);
    const meta = readMeta(dir);
    if (!meta) continue;
    if (meta.taskTitle) taskTitles.set(meta.taskId, meta.taskTitle);
    for (const run of meta.runs) {
      links.set(run.sessionId, { taskId: meta.taskId, role: run.role });
    }
  }
  return { links, taskTitles };
}

export function GET() {
  const now = Date.now();
  if (responseCache && responseCache.expires > now) {
    return NextResponse.json(responseCache.value);
  }
  const md = readBridgeMd();
  const { links, taskTitles } = buildLinkIndex();

  const seen = new Set<string>();
  const seenProjectDirs = new Set<string>();
  const repos: Array<{ name: string; path: string; isBridge: boolean }> = [];
  const push = (name: string, path: string, isBridge: boolean) => {
    if (seen.has(path)) return;
    seen.add(path);
    seenProjectDirs.add(projectDirFor(path));
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
  } catch { }

  for (const orphan of discoverOrphanProjects(seenProjectDirs)) {
    if (seen.has(orphan.path)) continue;
    seen.add(orphan.path);
    repos.push({ name: orphan.name, path: orphan.path, isBridge: false });
  }

  const out: SessionRow[] = [];

  const branchCache = new Map<string, string | null>();
  const branchOf = (path: string) => {
    if (!branchCache.has(path)) branchCache.set(path, readGitBranch(path));
    return branchCache.get(path) ?? null;
  };

  const listedProjectDirs = new Set<string>();
  const emittedSessionIds = new Set<string>();
  for (const r of repos) {
    const projectDir = projectDirFor(r.path);
    if (listedProjectDirs.has(projectDir)) continue;
    listedProjectDirs.add(projectDir);
    for (const s of listSessions(projectDir)) {
      if (emittedSessionIds.has(s.sessionId)) continue;
      emittedSessionIds.add(s.sessionId);
      const link = links.get(s.sessionId) ?? null;
      const linkedTitle = link ? taskTitles.get(link.taskId) : undefined;
      const preview = linkedTitle?.trim() ? linkedTitle : s.preview;
      out.push({
        sessionId: s.sessionId,
        repo: r.name,
        repoPath: r.path,
        branch: branchOf(r.path),
        isBridge: r.isBridge,
        mtime: s.mtime,
        size: s.size,
        preview,
        link,
      });
    }
  }

  const sorted = out.sort((a, b) => b.mtime - a.mtime);
  responseCache = { value: sorted, expires: now + RESPONSE_TTL_MS };
  return NextResponse.json(sorted);
}
