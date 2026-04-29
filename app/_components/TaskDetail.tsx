"use client";

import { useEffect, useMemo, useState } from "react";
import type { Meta, Repo, Run, Task } from "@/libs/client/types";
import {
  Hash,
  Copy,
  Check,
  CheckCircle2,
  Circle,
  Trash2,
  Terminal,
  Crown,
  GitBranch,
  RotateCw,
  Download,
} from "lucide-react";
import { exportTaskMarkdown, downloadFile } from "@/libs/client/exportTask";
import { TokenUsage, type TokenTotals } from "./TokenUsage";
import { StatusDot } from "./StatusDot";
import { relativeTime, duration } from "@/libs/client/time";
import { useToast } from "./Toasts";
import { useConfirm } from "./ConfirmProvider";
import { api } from "@/libs/client/api";
import { AgentTree } from "./AgentTree";
import { Button } from "./ui/button";

interface TaskDetailProps {
  task: Task | null;
  meta: Meta | null;
  repos: Repo[];
  activeRunId: string | null;
  onSelectRun: (run: Run) => void;
  onDelete: () => Promise<void>;
  onToggleComplete: (next: boolean) => Promise<void>;
  /**
   * Per-child live status (Thinking… / Running: <tool>) sourced from
   * the per-task SSE `child-status` event. Optional — undefined / empty
   * map renders the tree exactly as before. Keys are sessionIds.
   */
  liveStatusBySession?: Map<string, { kind: string; label?: string }>;
}

// Outer keys the inner by task.id so switching between tasks
// remounts the inner — title / body / usage state is reinitialised
// from the new task without the reset effect that React 19's
// `set-state-in-effect` rule (correctly) flags as a derived-state
// anti-pattern.
export function TaskDetail(props: TaskDetailProps) {
  return (
    <TaskDetailInner
      key={props.task?.id ?? "__none__"}
      {...props}
    />
  );
}

function TaskDetailInner({
  task,
  meta,
  repos,
  activeRunId,
  onSelectRun,
  onDelete,
  onToggleComplete,
  liveStatusBySession,
}: TaskDetailProps) {
  const [continuing, setContinuing] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [copiedId, setCopiedId] = useState(false);
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [usage, setUsage] = useState<TokenTotals | null>(null);
  const toast = useToast();
  const confirm = useConfirm();

  const branchByRepo = useMemo(() => {
    const map: Record<string, string | null> = {};
    for (const r of repos) map[r.name] = r.branch ?? null;
    return map;
  }, [repos]);

  // Refetch token totals whenever the run roster changes (a new run
  // landed, an existing one transitioned). Lightweight (one route hit)
  // and the route reads each .jsonl off disk so we always reflect what
  // claude actually billed.
  useEffect(() => {
    if (!task?.id) return;
    const ac = new AbortController();
    api.taskUsage(task.id, { signal: ac.signal })
      .then((r) => { if (!ac.signal.aborted) setUsage(r.total); })
      .catch(() => { /* 404 ok if meta hasn't landed yet, or aborted */ });
    return () => ac.abort();
  }, [task?.id, meta?.runs?.length, meta?.runs]);

  const continueTask = async () => {
    if (!task || continuing) return;
    setContinuing(true);
    try {
      const result = await api.continueTask(task.id);
      toast("success", result.action === "resumed" ? "Resumed coordinator" : "Spawned new coordinator");
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setContinuing(false);
    }
  };

  const toggleComplete = async () => {
    if (!task || toggling) return;
    const next = !task.checked;
    setToggling(true);
    try {
      await onToggleComplete(next);
      toast("info", next ? "Marked complete" : "Reopened — back to DOING");
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setToggling(false);
    }
  };

  if (!task) {
    return (
      <section className="flex-1 flex items-center justify-center text-fg-dim text-sm">
        <div className="text-center">
          <Hash size={32} className="mx-auto mb-2 opacity-30" />
          <p>Select a task to view details</p>
          <p className="text-xs mt-1 text-fg-dim/70">⌘N to create</p>
        </div>
      </section>
    );
  }

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(task.id);
      setCopiedId(true);
      setTimeout(() => setCopiedId(false), 1500);
    } catch { toast("error", "Clipboard blocked"); }
  };

  const cliHint = `Work on bridge task ${task.id}`;
  const copyCli = async () => {
    try {
      await navigator.clipboard.writeText(cliHint);
      setCopiedCmd(true);
      setTimeout(() => setCopiedCmd(false), 1500);
      toast("info", "Paste into your `claude` CLI in the bridge repo");
    } catch { toast("error", "Clipboard blocked"); }
  };

  const confirmDelete = async () => {
    const ok = await confirm({
      title: `Delete task ${task.id}?`,
      description: `"${task.title}"\n\nAlso removes sessions/${task.id}/ metadata. Sessions in ~/.claude are kept.`,
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    try { await onDelete(); toast("info", "Task deleted"); }
    catch (e) { toast("error", (e as Error).message); }
  };

  const runs = meta?.runs ?? [];
  const hasRuns = runs.length > 0;
  const owner = runs.find((r) => r.role === "coordinator") ?? null;
  // Most recent coordinator run drives the Continue button: only show
  // it when the user stopped the coordinator mid-way (killed) or the
  // process died unexpectedly (reaper marks it stale). Hide when the
  // coordinator is queued / running / cleanly done.
  const lastCoordinator = [...runs].reverse().find((r) => r.role === "coordinator") ?? null;
  const canContinue = !!lastCoordinator
    && (lastCoordinator.status === "failed" || lastCoordinator.status === "stale");

  const handleKill = async (run: Run) => {
    if (!task) return;
    const ok = await confirm({
      title: `Kill ${run.role}?`,
      description: `Stops session ${run.sessionId.slice(0, 8)}… (SIGTERM, then SIGKILL after 3s).\nThe run is flipped to failed in meta.json.`,
      confirmLabel: "Kill",
      destructive: true,
    });
    if (!ok) return;
    try {
      const r = await fetch(`/api/tasks/${task.id}/runs/${run.sessionId}/kill`, {
        method: "POST",
      });
      if (!r.ok) {
        const text = await r.text();
        throw new Error(`${r.status} ${text}`);
      }
      toast("info", `Killed ${run.role}`);
    } catch (e) {
      toast("error", (e as Error).message);
    }
  };

  return (
    <section className="flex-1 min-w-0 overflow-y-auto border-r border-border">
      <div className="p-4 sm:p-6 max-w-3xl mx-auto">
        <div className="flex items-center gap-2 mb-3 text-xs flex-wrap">
          <Button
            onClick={copyId}
            variant="ghost"
            size="xs"
            title="Copy task ID"
            className="font-mono text-fg-dim h-6 px-1.5 gap-1 hover:bg-transparent hover:text-foreground"
          >
            {task.id}
            {copiedId ? <Check size={11} className="text-success" /> : <Copy size={11} className="opacity-60" />}
          </Button>
          <span className="text-fg-dim ml-auto">{relativeTime(meta?.createdAt ?? `${task.date}T00:00:00Z`)}</span>
          <Button
            onClick={toggleComplete}
            disabled={toggling}
            variant={task.checked ? "secondary" : "outline"}
            size="xs"
            title={task.checked ? "Reopen — moves back to DOING" : "Mark complete — moves to DONE"}
            aria-label={task.checked ? "Reopen task" : "Mark task complete"}
            className="h-6 px-2 gap-1"
          >
            {task.checked ? (
              <CheckCircle2 size={12} className="text-success" />
            ) : (
              <Circle size={12} className="opacity-70" />
            )}
            <span className="hidden sm:inline">
              {task.checked ? "Completed" : "Mark complete"}
            </span>
          </Button>
          <Button
            onClick={() => downloadFile(`${task.id}.md`, exportTaskMarkdown(task, meta))}
            variant="ghost"
            size="iconSm"
            title="Export task summary as Markdown"
            className="text-fg-dim hover:text-foreground h-6 w-6"
          >
            <Download size={13} />
          </Button>
          <Button
            onClick={confirmDelete}
            variant="ghost"
            size="iconSm"
            title="Delete task"
            className="text-fg-dim hover:text-destructive h-6 w-6"
          >
            <Trash2 size={13} />
          </Button>
        </div>

        {task.checked && (
          <div
            className="mb-3 flex items-center gap-2 rounded-md border border-success/30 bg-success/10 px-3 py-2 text-xs text-success"
            role="status"
          >
            <CheckCircle2 size={14} className="shrink-0" />
            <span className="font-medium">Task completed</span>
            <span className="text-success/70">
              · marked done by you. Per-run statuses below reflect each agent&apos;s last state, independent of this checkbox.
            </span>
          </div>
        )}

        {usage && usage.turns > 0 && (
          <div className="mb-3 rounded-md border border-border bg-secondary/40 px-3 py-2">
            <div className="flex items-center gap-1.5 mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
              Token usage <span className="text-fg-dim normal-case font-normal">· summed across all runs</span>
            </div>
            <TokenUsage totals={usage} variant="detailed" />
          </div>
        )}

        <h2
          className={`mb-3 border-b border-border pb-2 text-base sm:text-lg font-medium leading-snug ${
            task.checked ? "line-through text-muted-foreground" : ""
          }`}
        >
          {task.title}
        </h2>

        {canContinue && (
          <div className="flex gap-2 mb-6 items-center flex-wrap">
            <Button
              disabled={continuing}
              onClick={continueTask}
              variant="secondary"
              size="sm"
              title="Resume the coordinator (last run was killed or died unexpectedly)"
              className="shrink-0"
            >
              <RotateCw size={14} className={continuing ? "animate-spin" : ""} />
              {continuing ? "Continuing…" : "Continue"}
            </Button>
            <span className="text-[11px] text-fg-dim min-w-0 flex-1">
              Last coordinator run ended in <span className="font-mono">{lastCoordinator?.status}</span> — pick up where it stopped.
            </span>
          </div>
        )}

        {!hasRuns && (
          <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 mb-6">
            <div className="flex items-center gap-2 mb-2 text-xs font-medium text-foreground">
              <Terminal size={13} className="text-primary" /> Assign this task to a Claude session
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed mb-2">
              Open <code className="font-mono text-foreground">claude</code> in the bridge repo (or any sibling) and paste the line below. The CLAUDE.md guide self-registers the session — it will appear here as an agent.
            </p>
            <Button
              onClick={copyCli}
              variant="outline"
              size="sm"
              className="w-full justify-start font-mono text-xs h-auto py-2"
            >
              <span className="text-muted-foreground">$</span>
              <span className="flex-1 text-left">{cliHint}</span>
              {copiedCmd ? <Check size={12} className="text-success" /> : <Copy size={12} className="text-fg-dim" />}
            </Button>
          </div>
        )}

        {owner && (() => {
          const ownerBranch = branchByRepo[owner.repo] ?? null;
          return (
            <>
              <h3 className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Owner</h3>
              <Button
                onClick={() => onSelectRun(owner)}
                variant="outline"
                size="sm"
                className={`w-full mb-4 justify-start text-xs font-mono h-auto py-2.5 bg-primary/5 ${
                  activeRunId === owner.sessionId ? "border-primary/60 ring-1 ring-primary/30" : "border-primary/30 hover:bg-primary/10"
                }`}
              >
                <Crown size={13} className="text-warning shrink-0" />
                <StatusDot status={owner.status} />
                <span className="text-foreground font-semibold">coordinator</span>
                <span className="text-fg-dim truncate">@ {owner.repo}</span>
                {ownerBranch && (
                  <span
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-secondary border border-border text-[9px] text-fg-dim font-mono shrink-0"
                    title={`branch: ${ownerBranch}`}
                  >
                    <GitBranch size={9} className="opacity-70" />
                    {ownerBranch}
                  </span>
                )}
                {owner.startedAt && (
                  <span className="text-fg-dim">· {relativeTime(owner.startedAt)}</span>
                )}
                {duration(owner.startedAt, owner.endedAt) && (
                  <span className="text-fg-dim">· {duration(owner.startedAt, owner.endedAt)}</span>
                )}
                <span className="ml-auto text-fg-dim uppercase text-[10px]">{owner.status}</span>
              </Button>
            </>
          );
        })()}

        <h3 className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
          Agent tree
        </h3>
        {hasRuns ? (
          <AgentTree
            meta={meta}
            taskId={task.id}
            activeSessionId={activeRunId}
            onSelectRun={onSelectRun}
            onKill={handleKill}
            branchByRepo={branchByRepo}
            liveStatusBySession={liveStatusBySession}
          />
        ) : (
          <p className="text-xs text-fg-dim italic">No sessions linked yet.</p>
        )}
      </div>
    </section>
  );
}
