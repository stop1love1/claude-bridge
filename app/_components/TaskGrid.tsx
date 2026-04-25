"use client";

import { useState } from "react";
import type { Meta, Task } from "@/lib/client/types";
import { Crown, Sparkles, Plus, Inbox, Trash2 } from "lucide-react";
import { relativeTime } from "@/lib/client/time";
import { STATUS_PILL, type DerivedStatus } from "@/lib/client/runStatus";

const ROLE_ICON: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  coordinator: Crown,
};
const ROLE_COLOR: Record<string, string> = {
  coordinator: "text-warning",
};

function roleIcon(role: string) { return ROLE_ICON[role] ?? Sparkles; }
function roleColor(role: string) { return ROLE_COLOR[role] ?? "text-muted-foreground"; }

function deriveStatus(meta: Meta | undefined): DerivedStatus {
  if (!meta) return "spawning";
  const runs = meta.runs ?? [];
  const createdMs = meta.createdAt ? new Date(meta.createdAt).getTime() : 0;
  const fresh = createdMs > 0 && Date.now() - createdMs < 20_000;
  if (runs.length === 0) return fresh ? "spawning" : "idle";
  if (runs.some((r) => r.status === "running")) return "running";
  if (runs.some((r) => r.status === "failed")) return "failed";
  if (runs.some((r) => r.status === "done")) return "done";
  return "idle";
}

function GridCard({
  task,
  meta,
  active,
  onOpen,
  onDelete,
  onToggleComplete,
}: {
  task: Task;
  meta: Meta | undefined;
  active: boolean;
  onOpen: () => void;
  onDelete: () => void;
  onToggleComplete: (next: boolean) => void;
}) {
  const runs = meta?.runs ?? [];
  const roleSet = Array.from(new Set(runs.map((r) => r.role)));
  // The bridge itself runs the coordinator role; hide it from the
  // sibling-repo summary so the chip list reflects only app repos.
  const repoSet = Array.from(
    new Set(
      runs
        .filter((r) => r.role !== "coordinator")
        .map((r) => r.repo),
    ),
  );
  const status = deriveStatus(meta);
  const pill = STATUS_PILL[status];
  const agentCount = runs.length;

  return (
    <div
      onClick={onOpen}
      className={`group relative rounded-lg border p-3 cursor-pointer transition-all bg-card ${
        active
          ? "border-primary/60 shadow-[0_0_0_1px_rgb(106,168,255,0.3)]"
          : "border-border hover:border-border hover:bg-accent"
      } ${status === "running" ? "ring-1 ring-warning/30" : ""}`}
    >
      <div className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={task.checked}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onToggleComplete(e.target.checked)}
          aria-label={task.checked ? `Reopen task ${task.id}` : `Mark task ${task.id} complete`}
          title={task.checked ? "Reopen — moves back to DOING" : "Mark complete — moves to DONE"}
          className="mt-0.5 shrink-0 accent-primary cursor-pointer"
        />
        <h3
          className={`flex-1 text-sm font-medium line-clamp-2 min-w-0 ${
            task.checked ? "line-through text-muted-foreground" : "text-foreground"
          }`}
        >
          {task.title}
        </h3>
        <span
          className={`shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-semibold uppercase tracking-wide ${pill.cls}`}
        >
          {pill.pulse && (
            <span className="relative inline-flex h-1.5 w-1.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-current opacity-60" />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-current" />
            </span>
          )}
          {pill.label}
        </span>
      </div>

      {(roleSet.length > 0 || repoSet.length > 0 || agentCount > 0) && (
        <div className="flex items-center gap-1.5 flex-wrap mt-2">
          {roleSet.map((role) => {
            const Icon = roleIcon(role);
            const color = roleColor(role);
            return (
              <Icon key={role} size={12} className={`${color} shrink-0`} aria-label={role} />
            );
          })}
          {agentCount > 0 && (
            <span className="text-[10px] text-muted-foreground">
              {agentCount} {agentCount === 1 ? "agent" : "agents"}
            </span>
          )}
          {repoSet.map((r) => (
            <span
              key={r}
              className="text-[9px] font-mono font-semibold px-1 py-px rounded bg-primary/10 text-primary truncate max-w-[100px]"
              title={r}
            >
              {r}
            </span>
          ))}
        </div>
      )}

      <div className="mt-2 flex items-center justify-between text-[10px] text-fg-dim">
        <span>{relativeTime(meta?.createdAt ?? `${task.date}T00:00:00Z`)}</span>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="p-1 rounded text-fg-dim hover:text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-destructive"
          aria-label={`Delete task ${task.id}`}
          title="Delete task"
        >
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
}

export function TaskGrid({
  tasks,
  metaByTask,
  activeTaskId,
  query,
  onOpenTask,
  onQuickAdd,
  onDeleteTask,
  onToggleComplete,
}: {
  tasks: Task[];
  metaByTask: Map<string, Meta>;
  activeTaskId: string | null;
  query: string;
  onOpenTask: (id: string) => void;
  onQuickAdd: (body: string) => void;
  onDeleteTask: (id: string) => void;
  onToggleComplete: (id: string, next: boolean) => void;
}) {
  const [quick, setQuick] = useState("");

  const q = query.trim().toLowerCase();
  const filtered = q
    ? tasks.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          t.body.toLowerCase().includes(q) ||
          t.id.toLowerCase().includes(q),
      )
    : tasks;

  const sorted = [...filtered].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });

  const submitQuick = () => {
    const v = quick.trim();
    if (!v) return;
    onQuickAdd(v);
    setQuick("");
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="shrink-0 px-4 pt-3 pb-2 flex items-center gap-2 border-b border-border bg-background">
        <Plus size={14} className="text-fg-dim shrink-0" />
        <input
          value={quick}
          onChange={(e) => setQuick(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submitQuick();
            } else if (e.key === "Escape") {
              setQuick("");
            }
          }}
          placeholder="Quick add — press Enter"
          className="flex-1 bg-transparent text-xs placeholder:text-fg-dim focus:outline-none"
        />
      </div>

      <div className="flex-1 overflow-y-auto">
        {sorted.length === 0 ? (
          <div className="h-full flex items-center justify-center text-fg-dim">
            <div className="text-center">
              <Inbox size={32} className="mx-auto mb-2 opacity-30" />
              <p className="text-sm">
                {q ? "No matches" : "No tasks yet. Press ⌘N or click New task."}
              </p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 p-4">
            {sorted.map((t) => (
              <GridCard
                key={t.id}
                task={t}
                meta={metaByTask.get(t.id)}
                active={activeTaskId === t.id}
                onOpen={() => onOpenTask(t.id)}
                onDelete={() => onDeleteTask(t.id)}
                onToggleComplete={(next) => onToggleComplete(t.id, next)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
