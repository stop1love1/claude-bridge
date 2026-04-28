import { NextResponse } from "next/server";
import { readdirSync, existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { resolveRepos } from "@/lib/repos";
import { discoverOrphanProjects, listSessions, projectDirFor } from "@/lib/sessions";
import { readMeta, subscribeMetaAll } from "@/lib/meta";
import { readGitBranch } from "@/lib/git";
import { BRIDGE_ROOT, SESSIONS_DIR, readBridgeMd } from "@/lib/paths";

export const dynamic = "force-dynamic";

// Whole-response cache. The sessions browser polls this endpoint every
// few seconds; without caching each call walks SESSIONS_DIR + every
// .jsonl under ~/.claude/projects/<slug>/ to compute previews. Stale
// data is acceptable for ~2 s — explicit invalidation through the meta
// event bus keeps newly-spawned runs visible immediately.
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

// Invalidate on any meta change (writeMeta, appendRun, transition…).
// `subscribeMetaAll` returns an unsubscribe but we hold the listener
// for the process lifetime — same trick as the rest of the bridge's
// global registries. HMR-safe via the underlying EventEmitter stash.
const G = globalThis as unknown as { __bridgeSessionsAllSub?: boolean };
if (!G.__bridgeSessionsAllSub) {
  G.__bridgeSessionsAllSub = true;
  subscribeMetaAll(() => { responseCache = null; });
}

interface LinkInfo { taskId: string; role: string }

/**
 * Build an index of session-id → {taskId, role} AND a parallel index
 * of taskId → taskTitle so the route can override session previews with
 * the task title (in the operator's language) when the session is a
 * child agent of a known task. Without this, child sessions show their
 * system prompt's first line — invariably English ("You are a `coder`
 * agent…") — even when the task body is Vietnamese, which made the
 * sessions list desync from the tasks board.
 */
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

/**
 * Returns every Claude session under each candidate folder we know about:
 *
 *   - the bridge itself
 *   - every repo declared in BRIDGE.md
 *   - any sibling folder of the bridge that exists on disk
 *   - every other project folder under `~/.claude/projects/` that holds
 *     at least one session (worktrees, unrelated repos, sessions started
 *     in `~`, etc) — recovered via the cwd field stored in each .jsonl
 *
 * That mirrors the discovery logic in `/api/repos` for the spawn-target
 * cases AND surfaces every transcript Claude has written, so the
 * sessions panel never silently hides a session because its cwd doesn't
 * match a registered repo. Each entry includes both the short folder
 * name (`repo`) and the full absolute path (`repoPath`) so the UI can
 * group on either.
 */
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
  } catch { /* parent unreadable */ }

  // Pick up every other ~/.claude/projects/<slug>/ folder that has at
  // least one session and isn't already covered above. The cwd is
  // recovered from the first transcript line so the path we surface is
  // the real one Claude saw, not a lossy slug-decode.
  for (const orphan of discoverOrphanProjects(seenProjectDirs)) {
    if (seen.has(orphan.path)) continue;
    seen.add(orphan.path);
    repos.push({ name: orphan.name, path: orphan.path, isBridge: false });
  }

  const out: SessionRow[] = [];

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
      const link = links.get(s.sessionId) ?? null;
      // For sessions linked to a task, prefer the task title (in the
      // operator's language) over the .jsonl preview (which is the
      // system prompt's first line — always English). Free-chat /
      // orphan sessions keep their preview.
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
