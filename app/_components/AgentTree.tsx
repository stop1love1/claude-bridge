"use client";

import { memo, useMemo } from "react";
import { Crown, Sparkles, X, GitBranch } from "lucide-react";
import type { Meta, Run } from "@/lib/client/types";
import { duration } from "@/lib/client/time";
import { RUN_STATUS_PILL } from "@/lib/client/runStatus";

const ROLE_ICON: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  coordinator: Crown,
};
const ROLE_COLOR: Record<string, string> = {
  coordinator: "text-warning",
};

function roleIcon(role: string) { return ROLE_ICON[role] ?? Sparkles; }
function roleColor(role: string) { return ROLE_COLOR[role] ?? "text-muted-foreground"; }

interface TreeNode {
  run: Run;
  children: TreeNode[];
}

/**
 * Build a parent->child tree from a flat `runs[]` array. The root is
 * the run with no `parentSessionId` AND `role === "coordinator"`. If
 * neither matches (legacy meta.json), we fall back to the first run.
 *
 * Children = runs whose `parentSessionId === parent.sessionId`. Anything
 * orphaned (parentSessionId points at a run that doesn't exist in the
 * task's runs[]) is hoisted as a sibling of the root so it stays
 * visible.
 */
function buildTree(runs: Run[]): TreeNode[] {
  if (runs.length === 0) return [];
  const byId = new Map(runs.map((r) => [r.sessionId, r]));

  const root =
    runs.find((r) => !r.parentSessionId && r.role === "coordinator") ??
    runs.find((r) => !r.parentSessionId) ??
    runs[0];

  const visit = (run: Run): TreeNode => ({
    run,
    children: runs
      .filter((r) => r.parentSessionId && r.parentSessionId === run.sessionId)
      .map(visit),
  });

  const rooted = visit(root);

  // Surface orphans (parentSessionId set but parent not in runs[]) as
  // siblings of root so they don't disappear from the UI.
  const accountedFor = new Set<string>();
  const collect = (n: TreeNode) => {
    accountedFor.add(n.run.sessionId);
    n.children.forEach(collect);
  };
  collect(rooted);
  const orphans = runs
    .filter(
      (r) =>
        !accountedFor.has(r.sessionId) &&
        r.parentSessionId &&
        !byId.has(r.parentSessionId),
    )
    .map(visit);

  return [rooted, ...orphans];
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
  depth,
  activeSessionId,
  onSelectRun,
  onKill,
  branchByRepo,
}: {
  node: TreeNode;
  depth: number;
  activeSessionId: string | null;
  onSelectRun: (run: Run) => void;
  onKill?: (run: Run) => void;
  branchByRepo?: Record<string, string | null>;
}) {
  const { run } = node;
  const Icon = roleIcon(run.role);
  const iconCls = roleColor(run.role);
  const dur = duration(run.startedAt, run.endedAt);
  const active = activeSessionId === run.sessionId;
  const canKill = run.status === "running" && !!onKill;
  const branch = branchByRepo?.[run.repo] ?? null;

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
          title={`${run.role} @ ${run.repo}${branch ? ` (${branch})` : ""}\n${run.sessionId}`}
        >
          <Icon size={12} className={`${iconCls} shrink-0`} />
          <span className="text-foreground font-semibold shrink-0">{run.role}</span>
          <span className="text-fg-dim truncate">@ {run.repo}</span>
          {branch && (
            <span
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-secondary border border-border text-[9px] text-fg-dim font-mono shrink-0"
              title={`branch: ${branch}`}
            >
              <GitBranch size={9} className="opacity-70" />
              {branch}
            </span>
          )}
          <span className="ml-auto flex items-center gap-1.5 shrink-0">
            {dur && <span className="text-fg-dim text-[10px]">{dur}</span>}
            <StatusPill run={run} />
          </span>
        </button>
        {canKill && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onKill!(run);
            }}
            className="absolute -right-1 -top-1 p-1 rounded-full bg-card border border-border text-fg-dim hover:text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-destructive"
            aria-label={`Kill ${run.role}`}
            title={`Kill ${run.role}`}
          >
            <X size={10} />
          </button>
        )}
      </div>

      {node.children.length > 0 && (
        <ul className="mt-1 ml-4 pl-3 border-l border-border space-y-1">
          {node.children.map((c) => (
            <AgentNode
              key={c.run.sessionId}
              node={c}
              depth={depth + 1}
              activeSessionId={activeSessionId}
              onSelectRun={onSelectRun}
              onKill={onKill}
              branchByRepo={branchByRepo}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * Render a `meta.runs[]` array as a parent → child agent tree. Root is
 * the coordinator (or first parentless run); children are runs whose
 * `parentSessionId` points at their parent. Recursion is supported so
 * Phase D fix-agents under a coder still display correctly.
 *
 * - `onSelectRun` switches the chat panel to that run.
 * - `onKill` (optional) is called when the user clicks the hover-X on
 *   a `running` node. The parent should confirm + POST
 *   `/api/tasks/<id>/runs/<sid>/kill`.
 * - The tree is rendered even when only the coordinator exists — it's
 *   still useful as a one-glance status indicator.
 */
function AgentTreeInner({
  meta,
  activeSessionId,
  onSelectRun,
  onKill,
  branchByRepo,
}: {
  meta: Meta | null;
  activeSessionId: string | null;
  onSelectRun: (run: Run) => void;
  onKill?: (run: Run) => void;
  branchByRepo?: Record<string, string | null>;
}) {
  const tree = useMemo(() => buildTree(meta?.runs ?? []), [meta?.runs]);

  if (tree.length === 0) {
    return (
      <p className="text-xs text-fg-dim italic">No sessions linked yet.</p>
    );
  }

  return (
    <ul className="space-y-1.5">
      {tree.map((n) => (
        <AgentNode
          key={n.run.sessionId}
          node={n}
          depth={0}
          activeSessionId={activeSessionId}
          onSelectRun={onSelectRun}
          onKill={onKill}
          branchByRepo={branchByRepo}
        />
      ))}
    </ul>
  );
}

export const AgentTree = memo(AgentTreeInner);
