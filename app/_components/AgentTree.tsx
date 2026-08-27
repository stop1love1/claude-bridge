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
  roots: TreeNode[];
  pivotRun: Run;
}

interface Layout {
  owner: Run | null;
  repoGroups: RepoGroup[];
}

function buildLayout(runs: Run[]): Layout {
  if (runs.length === 0) return { owner: null, repoGroups: [] };
  const byId = new Map(runs.map((r) => [r.sessionId, r]));

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
    if (
      (run.startedAt ?? "") > (g.pivotRun.startedAt ?? "") ||
      (!g.pivotRun.startedAt && run.startedAt)
    ) {
      g.pivotRun = run;
    }
  }

  const repoGroups = [...groups.values()].sort((a, b) =>
    a.repo.localeCompare(b.repo),
  );

  return { owner, repoGroups };
}

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
          title={
            `${run.role} @ ${run.repo}\n${run.sessionId}` +
            (run.semanticVerifier?.votes && run.semanticVerifier.votes.length > 0
              ? `\n\nSemantic panel (${run.semanticVerifier.verdict}):\n` +
                run.semanticVerifier.votes
                  .map((v) => `• ${v.lens}: ${v.verdict} — ${v.reason}`)
                  .join("\n")
              : "")
          }
        >
          <RoleIcon role={run.role} size={12} className={`${iconCls} shrink-0`} />
          <span className="text-foreground font-semibold shrink-0">{run.role}</span>
          <span className="ml-auto flex items-center gap-1.5 shrink-0">
            {run.confidence && (
              <span
                className={`text-[9px] font-mono font-semibold px-1 py-px rounded ${
                  run.confidence.band === "high"
                    ? "bg-emerald-500/15 text-emerald-500"
                    : run.confidence.band === "medium"
                      ? "bg-amber-500/15 text-amber-500"
                      : "bg-red-500/15 text-red-500"
                }`}
                title={`Confidence ${run.confidence.score}/100 (${run.confidence.band})${run.confidence.heldAt ? " — held for review before shipping" : ""}`}
              >
                {run.confidence.heldAt ? "⏸ " : ""}{run.confidence.score}
              </span>
            )}
            {run.mergeNotPushed && (
              <span
                className="text-[9px] font-mono font-semibold px-1 py-px rounded bg-warning/20 text-warning"
                title={run.mergeNotPushed.message}
              >
                needs push
              </span>
            )}
            {dur && <span className="text-fg-dim text-[10px]">{dur}</span>}
            <StatusPill run={run} />
          </span>
        </button>
        {(canKill || canDelete) && (
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
        {}
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
