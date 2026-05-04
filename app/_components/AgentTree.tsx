"use client";

import { memo, useMemo, useState } from "react";
import {
  Crown,
  Sparkles,
  X,
  Trash2,
  GitBranch,
  GitCompare,
  Search,
  Wrench,
  Code,
  Compass,
  Microscope,
  Pen,
  MonitorPlay,
  Hammer,
  Palette,
  ShieldCheck,
  Folder,
} from "lucide-react";
import type { Meta, Run } from "@/libs/client/types";
import { duration } from "@/libs/client/time";
import { RUN_STATUS_PILL } from "@/libs/client/runStatus";
import { DiffViewer } from "./DiffViewer";

// Role-keyed color/icon. Roles are free-form strings the coordinator
// invents per task, so the lookup falls through to a neutral default.
// Retry suffixes (`-retry`, `-cretry`, `-svretry`, `-vretry`,
// `-stretry`) are stripped before the lookup so a `fixer-cretry`
// follow-up still renders as a wrench.
const ROLE_COLOR: Record<string, string> = {
  coordinator: "text-warning",
  reviewer: "text-primary",
  fixer: "text-success",
  coder: "text-primary",
  planner: "text-muted-foreground",
  surveyor: "text-muted-foreground",
  researcher: "text-muted-foreground",
  writer: "text-muted-foreground",
  "ui-tester": "text-success",
  tester: "text-success",
  qa: "text-success",
  builder: "text-warning",
  "api-builder": "text-warning",
  "ui-builder": "text-warning",
  "style-critic": "text-destructive",
  "semantic-verifier": "text-primary",
};

function normalizeRole(role: string): string {
  return role.replace(/-(retry|cretry|svretry|vretry|stretry)\d*$/, "");
}

function roleColor(role: string) {
  return ROLE_COLOR[normalizeRole(role)] ?? "text-muted-foreground";
}

// Stable wrapper around the lucide icon picked from `role`. Switch
// instead of a `roleIcon(role)` lookup that returns a component —
// React 19's `static-components` rule rejects rendering a component
// referenced via a function-returned variable because static analysis
// can't prove the result is stable across renders.
function RoleIcon({
  role,
  size,
  className,
}: {
  role: string;
  size?: number;
  className?: string;
}) {
  switch (normalizeRole(role)) {
    case "coordinator":
      return <Crown size={size} className={className} />;
    case "reviewer":
      return <Search size={size} className={className} />;
    case "fixer":
      return <Wrench size={size} className={className} />;
    case "coder":
      return <Code size={size} className={className} />;
    case "planner":
    case "surveyor":
      return <Compass size={size} className={className} />;
    case "researcher":
      return <Microscope size={size} className={className} />;
    case "writer":
      return <Pen size={size} className={className} />;
    case "ui-tester":
    case "tester":
    case "qa":
      return <MonitorPlay size={size} className={className} />;
    case "builder":
    case "api-builder":
    case "ui-builder":
      return <Hammer size={size} className={className} />;
    case "style-critic":
      return <Palette size={size} className={className} />;
    case "semantic-verifier":
      return <ShieldCheck size={size} className={className} />;
    default:
      return <Sparkles size={size} className={className} />;
  }
}

interface TreeNode {
  run: Run;
  children: TreeNode[];
}

interface RepoGroup {
  repo: string;
  /** Top-level nodes inside this repo (their parent is the coordinator
   *  or is missing from runs[]). Sub-children stay nested. */
  roots: TreeNode[];
  /** Most recent run in the group — used as the sessionId pivot for
   *  the repo-level "View Diff" button (every run in a repo group
   *  typically shares a worktree, so any of them produces the same
   *  diff; pick the freshest for clearest provenance). */
  pivotRun: Run;
}

interface Layout {
  /** The coordinator (or first parentless run if no coordinator) — rendered at the top. */
  owner: Run | null;
  /** Everything else, grouped by repo so the user can scan per-project. */
  repoGroups: RepoGroup[];
}

/**
 * Walk `runs[]` and produce: (a) the coordinator/owner row, (b) one
 * group per distinct child repo containing the runs in that repo,
 * already organised into parent-child sub-trees.
 *
 * The previous flat tree layout intermixed runs across repos — when
 * a coordinator dispatched to two apps, the user had to read the
 * `@ <repo>` suffix on every row to know which project a run
 * belonged to. Grouping by repo surfaces project boundaries
 * visually and lets us hang a single "View Diff" button per repo
 * (one diff per worktree, not per agent).
 *
 * Cycles in `parentSessionId` (pathological meta.json) are guarded
 * by `visited` so the recursion can't loop forever.
 */
function buildLayout(runs: Run[]): Layout {
  if (runs.length === 0) return { owner: null, repoGroups: [] };
  const byId = new Map(runs.map((r) => [r.sessionId, r]));

  // Coordinator picked the same way the legacy tree did: prefer a
  // role==="coordinator" parentless run; otherwise the first
  // parentless run; otherwise the first run.
  const owner =
    runs.find((r) => !r.parentSessionId && r.role === "coordinator") ??
    runs.find((r) => !r.parentSessionId) ??
    runs[0];

  const visit = (run: Run, visited: Set<string>): TreeNode => {
    if (visited.has(run.sessionId)) return { run, children: [] };
    const next = new Set(visited);
    next.add(run.sessionId);
    return {
      run,
      children: runs
        .filter(
          (r) =>
            r.parentSessionId &&
            r.parentSessionId === run.sessionId &&
            !next.has(r.sessionId),
        )
        .map((r) => visit(r, next)),
    };
  };

  // Repo groups: every run that isn't the owner. Top-level inside
  // each group = runs whose parent IS the owner OR whose parent
  // doesn't exist in the runs list (orphans). Sub-trees stay nested
  // for the rare case where one child spawns another.
  const groups = new Map<string, RepoGroup>();
  for (const run of runs) {
    if (run.sessionId === owner.sessionId) continue;
    const isTopLevel =
      !run.parentSessionId ||
      run.parentSessionId === owner.sessionId ||
      !byId.has(run.parentSessionId);
    if (!isTopLevel) continue;
    const node = visit(run, new Set<string>([owner.sessionId]));
    let g = groups.get(run.repo);
    if (!g) {
      g = { repo: run.repo, roots: [], pivotRun: run };
      groups.set(run.repo, g);
    }
    g.roots.push(node);
    // Pivot is the latest started/created in the group — best proxy
    // for "what worktree is currently most relevant".
    if (
      (run.startedAt ?? "") > (g.pivotRun.startedAt ?? "") ||
      (!g.pivotRun.startedAt && run.startedAt)
    ) {
      g.pivotRun = run;
    }
  }

  // Stable repo order: alphabetical by repo name. Predictable enough
  // for the user to find the same project in the same place across
  // tasks; deterministic for screenshot diff'ing.
  const repoGroups = [...groups.values()].sort((a, b) =>
    a.repo.localeCompare(b.repo),
  );

  return { owner, repoGroups };
}

/**
 * Trim a stream-json `task_started.description` to a one-line preview
 * for the live label. Some descriptions Claude attaches are full
 * paragraphs; we want a single concise line under the run row.
 */
function truncateLabel(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

function StatusPill({ run }: { run: Run }) {
  const pill = RUN_STATUS_PILL[run.status];
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-semibold uppercase tracking-wide ${pill.cls}`}
    >
      {pill.pulse && (
        <span className="relative inline-flex h-1.5 w-1.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-current opacity-60" />
          <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-current" />
        </span>
      )}
      {pill.label}
    </span>
  );
}

function AgentNode({
  node,
  activeSessionId,
  onSelectRun,
  onKill,
  onDelete,
  liveStatusBySession,
}: {
  node: TreeNode;
  activeSessionId: string | null;
  onSelectRun: (run: Run) => void;
  onKill?: (run: Run) => void;
  onDelete?: (run: Run) => void;
  liveStatusBySession?: Map<string, { kind: string; label?: string }>;
}) {
  const { run } = node;
  const iconCls = roleColor(run.role);
  const dur = duration(run.startedAt, run.endedAt);
  const active = activeSessionId === run.sessionId;
  const canKill = run.status === "running" && !!onKill;
  // Delete makes sense for terminal-state rows. Running rows show
  // Kill (SIGTERM) instead — the two actions are mutually exclusive
  // by status to avoid accidentally nuking a live agent.
  const canDelete = run.status !== "running" && run.status !== "queued" && !!onDelete;
  const live =
    run.status === "running"
      ? liveStatusBySession?.get(run.sessionId) ?? null
      : null;
  const liveLabel =
    live && live.kind === "running" && live.label
      ? `Running: ${truncateLabel(live.label, 80)}`
      : live && live.kind === "thinking"
      ? "Thinking…"
      : null;

  return (
    <li className="list-none">
      <div className="group/node relative">
        <button
          onClick={() => onSelectRun(run)}
          className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md border text-left text-xs font-mono transition-colors ${
            active
              ? "bg-primary/10 border-primary/60 ring-1 ring-primary/30"
              : "bg-card border-border hover:bg-accent"
          }`}
          title={`${run.role} @ ${run.repo}\n${run.sessionId}`}
        >
          <RoleIcon role={run.role} size={12} className={`${iconCls} shrink-0`} />
          <span className="text-foreground font-semibold shrink-0">{run.role}</span>
          <span className="ml-auto flex items-center gap-1.5 shrink-0">
            {dur && <span className="text-fg-dim text-[10px]">{dur}</span>}
            <StatusPill run={run} />
          </span>
        </button>
        {(canKill || canDelete) && (
          // On touch devices (no hover) the actions stay visible at all
          // times. From sm: up they hide and reveal on hover/focus —
          // standard "spatial" desktop UX.
          <div className="absolute -right-1 -top-1 flex sm:hidden sm:group-hover/node:flex sm:group-focus-within/node:flex">
            {canKill ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onKill!(run);
                }}
                className="p-1 rounded-full bg-card border border-border text-fg-dim hover:text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-destructive"
                aria-label={`Kill ${run.role}`}
                title={`Kill ${run.role} (SIGTERM)`}
              >
                <X size={10} />
              </button>
            ) : (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete!(run);
                }}
                className="p-1 rounded-full bg-card border border-border text-fg-dim hover:text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-destructive"
                aria-label={`Delete ${run.role}`}
                title={`Delete ${run.role} (removes meta + transcript)`}
              >
                <Trash2 size={10} />
              </button>
            )}
          </div>
        )}
      </div>

      {liveLabel && (
        <p
          className="mt-0.5 ml-7 text-[10px] font-mono text-fg-dim italic truncate"
          title={liveLabel}
        >
          {liveLabel}
        </p>
      )}

      {node.children.length > 0 && (
        <ul className="mt-1 ml-4 pl-3 border-l border-border space-y-1">
          {node.children.map((c) => (
            <AgentNode
              key={c.run.sessionId}
              node={c}
              activeSessionId={activeSessionId}
              onSelectRun={onSelectRun}
              liveStatusBySession={liveStatusBySession}
              onKill={onKill}
              onDelete={onDelete}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function RepoGroupView({
  group,
  branch,
  activeSessionId,
  onSelectRun,
  onKill,
  onDelete,
  onDiff,
  liveStatusBySession,
}: {
  group: RepoGroup;
  branch: string | null;
  activeSessionId: string | null;
  onSelectRun: (run: Run) => void;
  onKill?: (run: Run) => void;
  onDelete?: (run: Run) => void;
  onDiff?: (pivot: Run, repo: string) => void;
  liveStatusBySession?: Map<string, { kind: string; label?: string }>;
}) {
  return (
    <section className="space-y-1.5">
      <header className="flex items-center gap-2 px-2 py-1 rounded-md bg-secondary/40 border border-border/60">
        <Folder size={11} className="text-fg-dim shrink-0" />
        <span className="text-[11px] font-mono font-semibold text-foreground truncate">
          {group.repo}
        </span>
        {branch && (
          <span
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-card border border-border text-[9px] text-fg-dim font-mono shrink-0"
            title={`branch: ${branch}`}
          >
            <GitBranch size={9} className="opacity-70" />
            {branch}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1">
          <span className="text-[9px] text-fg-dim font-mono uppercase tracking-wide">
            {group.roots.length} agent{group.roots.length === 1 ? "" : "s"}
          </span>
          {onDiff && (
            <button
              type="button"
              onClick={() => onDiff(group.pivotRun, group.repo)}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-border bg-card text-[10px] text-fg-dim hover:text-primary hover:border-primary/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
              title={`View diff for ${group.repo}`}
              aria-label={`View diff for ${group.repo}`}
            >
              <GitCompare size={10} />
              Diff
            </button>
          )}
        </span>
      </header>

      <ul className="space-y-1 ml-1.5">
        {group.roots.map((n) => (
          <AgentNode
            key={n.run.sessionId}
            node={n}
            activeSessionId={activeSessionId}
            onSelectRun={onSelectRun}
            onKill={onKill}
            onDelete={onDelete}
            liveStatusBySession={liveStatusBySession}
          />
        ))}
      </ul>
    </section>
  );
}

/**
 * Render a `meta.runs[]` array as: coordinator at the top, then one
 * folder section per child repo with its agents grouped inside.
 *
 * - `onSelectRun` switches the chat panel to that run.
 * - `onKill` (optional) is called when the user clicks the hover-X on
 *   a `running` node. The parent should confirm + POST
 *   `/api/tasks/<id>/runs/<sid>/kill`.
 * - `onDelete` (optional) is called when the user clicks the hover-
 *   trash on a terminal-state node. The parent should confirm +
 *   `DELETE /api/sessions/<sid>?repo=<folder>` to remove the run
 *   from meta and delete the underlying `.jsonl`.
 * - The tree is rendered even when only the coordinator exists.
 */
function AgentTreeInner({
  meta,
  taskId,
  activeSessionId,
  onSelectRun,
  onKill,
  onDelete,
  branchByRepo,
  liveStatusBySession,
}: {
  meta: Meta | null;
  taskId?: string;
  activeSessionId: string | null;
  onSelectRun: (run: Run) => void;
  onKill?: (run: Run) => void;
  onDelete?: (run: Run) => void;
  branchByRepo?: Record<string, string | null>;
  liveStatusBySession?: Map<string, { kind: string; label?: string }>;
}) {
  const layout = useMemo(() => buildLayout(meta?.runs ?? []), [meta?.runs]);
  const [diff, setDiff] = useState<{ run: Run; repo: string } | null>(null);
  // Diff endpoint requires a task id to look up meta — without it we
  // suppress the inline diff button entirely instead of failing later.
  const onDiff = taskId ? (run: Run, repo: string) => setDiff({ run, repo }) : undefined;

  if (layout.repoGroups.length === 0) {
    return (
      <p className="text-xs text-fg-dim italic">
        No agent runs yet — the coordinator hasn&apos;t dispatched anything to a project.
      </p>
    );
  }

  return (
    <>
      <div className="space-y-3">
        {/* Coordinator is rendered by TaskDetail's separate Owner section
            above the tree — duplicating it here would pad the tree with
            a row the user already sees. We still use it for layout
            decisions (parent linkage), just don't render its row. */}
        {layout.repoGroups.map((g) => (
          <RepoGroupView
            key={g.repo}
            group={g}
            branch={branchByRepo?.[g.repo] ?? null}
            activeSessionId={activeSessionId}
            onSelectRun={onSelectRun}
            onKill={onKill}
            onDelete={onDelete}
            onDiff={onDiff}
            liveStatusBySession={liveStatusBySession}
          />
        ))}
      </div>
      {taskId && diff && (
        <DiffViewer
          taskId={taskId}
          sessionId={diff.run.sessionId}
          role={diff.run.role}
          repo={diff.repo}
          open={!!diff}
          onClose={() => setDiff(null)}
        />
      )}
    </>
  );
}

export const AgentTree = memo(AgentTreeInner);
