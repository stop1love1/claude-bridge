// AgentTree — render `meta.runs[]` as a parent → child tree. Roots
// at the coordinator (or first parentless run); children are runs
// whose `parentSessionId` points at their parent. Cycle-safe.
//
// Lighter than the main version: no inline DiffViewer, no live
// stream-json activity labels (those plug back in once the bridge SSE
// surface is ported). The selection callback drives SessionLog
// switching from the parent.

import { memo, useMemo } from "react";
import {
  Code,
  Compass,
  Crown,
  GitBranch,
  Hammer,
  Microscope,
  MonitorPlay,
  Palette,
  Pen,
  Search,
  ShieldCheck,
  Sparkles,
  Wrench,
  X,
} from "lucide-react";
import type { Run, TaskMeta } from "@/api/types";
import StatusDot from "@/components/StatusDot";
import { durationMs } from "@/lib/time";
import { cn } from "@/lib/cn";

const ROLE_COLOR: Record<string, string> = {
  coordinator: "text-status-doing",
  reviewer: "text-primary",
  fixer: "text-status-done",
  coder: "text-primary",
  planner: "text-muted-foreground",
  surveyor: "text-muted-foreground",
  researcher: "text-muted-foreground",
  writer: "text-muted-foreground",
  "ui-tester": "text-status-done",
  tester: "text-status-done",
  qa: "text-status-done",
  builder: "text-status-doing",
  "api-builder": "text-status-doing",
  "ui-builder": "text-status-doing",
  "style-critic": "text-status-blocked",
  "semantic-verifier": "text-primary",
};

function normalizeRole(role: string): string {
  return role.replace(/-(retry|cretry|svretry)$/, "");
}

function roleColor(role: string): string {
  return ROLE_COLOR[normalizeRole(role)] ?? "text-muted-foreground";
}

function RoleIcon({ role, size = 12 }: { role: string; size?: number }) {
  switch (normalizeRole(role)) {
    case "coordinator":
      return <Crown size={size} />;
    case "reviewer":
      return <Search size={size} />;
    case "fixer":
      return <Wrench size={size} />;
    case "coder":
      return <Code size={size} />;
    case "planner":
    case "surveyor":
      return <Compass size={size} />;
    case "researcher":
      return <Microscope size={size} />;
    case "writer":
      return <Pen size={size} />;
    case "ui-tester":
    case "tester":
    case "qa":
      return <MonitorPlay size={size} />;
    case "builder":
    case "api-builder":
    case "ui-builder":
      return <Hammer size={size} />;
    case "style-critic":
      return <Palette size={size} />;
    case "semantic-verifier":
      return <ShieldCheck size={size} />;
    default:
      return <Sparkles size={size} />;
  }
}

interface TreeNode {
  run: Run;
  children: TreeNode[];
}

function buildTree(runs: Run[]): TreeNode[] {
  if (runs.length === 0) return [];
  const byId = new Map(runs.map((r) => [r.sessionId, r]));
  const root =
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

  const rooted = visit(root, new Set<string>());
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
    .map((r) => visit(r, new Set<string>()));
  return [rooted, ...orphans];
}

function AgentNode({
  node,
  activeSessionId,
  onSelectRun,
  onKill,
}: {
  node: TreeNode;
  activeSessionId: string | null;
  onSelectRun: (run: Run) => void;
  onKill?: (run: Run) => void;
}) {
  const { run } = node;
  const active = activeSessionId === run.sessionId;
  const dur = durationMs(run.startedAt, run.endedAt);
  const canKill = run.status === "running" && !!onKill;

  return (
    <li className="list-none">
      <div className="group/node relative">
        <button
          type="button"
          onClick={() => onSelectRun(run)}
          className={cn(
            "flex w-full items-center gap-2 rounded-sm border px-2.5 py-1.5 text-left font-mono text-xs transition-colors",
            active
              ? "border-primary/60 bg-primary/10 ring-1 ring-primary/30"
              : "border-border bg-card hover:bg-secondary",
          )}
          title={`${run.role} @ ${run.repo}\n${run.sessionId}`}
        >
          <span className={cn("shrink-0", roleColor(run.role))}>
            <RoleIcon role={run.role} size={12} />
          </span>
          <span className="shrink-0 font-semibold text-foreground">{run.role}</span>
          <span className="truncate text-muted-foreground">@ {run.repo || "—"}</span>
          {run.worktreeBranch && (
            <span
              className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-secondary px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground"
              title={`branch: ${run.worktreeBranch}`}
            >
              <GitBranch size={9} className="opacity-70" />
              {run.worktreeBranch}
            </span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-2">
            <span className="font-mono text-[10px] tabular-nums text-fg-dim">
              {dur}
            </span>
            <StatusDot status={run.status} size="xs" />
          </span>
        </button>
        {canKill && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onKill!(run);
            }}
            className="absolute -right-1 -top-1 rounded-full border border-border bg-card p-0.5 text-muted-foreground opacity-0 hover:bg-status-blocked/10 hover:text-status-blocked group-hover/node:opacity-100"
            aria-label={`kill ${run.role}`}
            title={`kill ${run.role}`}
          >
            <X size={10} />
          </button>
        )}
      </div>
      {node.children.length > 0 && (
        <ul className="ml-4 mt-1 space-y-1 border-l border-border pl-3">
          {node.children.map((c) => (
            <AgentNode
              key={c.run.sessionId}
              node={c}
              activeSessionId={activeSessionId}
              onSelectRun={onSelectRun}
              onKill={onKill}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function AgentTreeInner({
  meta,
  activeSessionId,
  onSelectRun,
  onKill,
}: {
  meta: TaskMeta | null | undefined;
  activeSessionId: string | null;
  onSelectRun: (run: Run) => void;
  onKill?: (run: Run) => void;
}) {
  const tree = useMemo(() => buildTree(meta?.runs ?? []), [meta?.runs]);
  if (tree.length === 0) {
    return (
      <p className="font-mono text-micro tracking-wideish text-fg-dim">
        no sessions linked yet.
      </p>
    );
  }
  return (
    <ul className="space-y-1.5">
      {tree.map((n) => (
        <AgentNode
          key={n.run.sessionId}
          node={n}
          activeSessionId={activeSessionId}
          onSelectRun={onSelectRun}
          onKill={onKill}
        />
      ))}
    </ul>
  );
}

export const AgentTree = memo(AgentTreeInner);
export default AgentTree;
