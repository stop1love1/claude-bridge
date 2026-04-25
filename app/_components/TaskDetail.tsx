"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Meta, Repo, Run, Task } from "@/lib/client/types";
import {
  Hash,
  Copy,
  Check,
  Trash2,
  Terminal,
  Crown,
  GitBranch,
  RotateCw,
} from "lucide-react";
import { StatusDot } from "./StatusDot";
import { relativeTime, duration } from "@/lib/client/time";
import { useToast } from "./Toasts";
import { useConfirm } from "./ConfirmProvider";
import { api } from "@/lib/client/api";
import { AgentTree } from "./AgentTree";

export function TaskDetail({
  task,
  meta,
  repos,
  activeRunId,
  onSave,
  onSelectRun,
  onDelete,
  saveRef,
}: {
  task: Task | null;
  meta: Meta | null;
  repos: Repo[];
  activeRunId: string | null;
  onSave: (patch: Partial<Task>) => Promise<void>;
  onSelectRun: (run: Run) => void;
  onDelete: () => Promise<void>;
  saveRef?: React.MutableRefObject<(() => void) | null>;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [copiedId, setCopiedId] = useState(false);
  const [copiedCmd, setCopiedCmd] = useState(false);
  // Synchronous flag — `setSaving(true)` only commits on the next
  // render, so two onBlur events firing in the same tick can both
  // observe `saving === false` and issue duplicate saves. The ref
  // serializes them deterministically.
  const savingRef = useRef(false);
  const toast = useToast();
  const confirm = useConfirm();
  const titleRef = useRef<HTMLInputElement>(null);

  const branchByRepo = useMemo(() => {
    const map: Record<string, string | null> = {};
    for (const r of repos) map[r.name] = r.branch ?? null;
    return map;
  }, [repos]);

  useEffect(() => {
    setTitle(task?.title ?? "");
    setBody(task?.body ?? "");
  }, [task?.id]);

  const dirty = task ? (title !== task.title || body !== task.body) : false;

  const save = async () => {
    if (!dirty || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try { await onSave({ title, body }); }
    catch (e) { toast("error", (e as Error).message); }
    finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

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

  useEffect(() => {
    if (!saveRef) return;
    saveRef.current = save;
    return () => { if (saveRef.current === save) saveRef.current = null; };
  });

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
      <div className="p-6 max-w-3xl mx-auto">
        <div className="flex items-center gap-2 mb-3 text-xs flex-wrap">
          <button
            onClick={copyId}
            className="inline-flex items-center gap-1 font-mono text-fg-dim hover:text-foreground transition-colors group"
            title="Copy task ID"
          >
            {task.id}
            {copiedId ? <Check size={11} className="text-success" /> : <Copy size={11} className="opacity-60 hover:opacity-100" />}
          </button>
          <span className="text-fg-dim ml-auto">{relativeTime(meta?.createdAt ?? `${task.date}T00:00:00Z`)}</span>
          <button
            onClick={confirmDelete}
            className="text-fg-dim hover:text-destructive transition-colors p-1 rounded"
            title="Delete task"
          >
            <Trash2 size={13} />
          </button>
        </div>

        <input
          ref={titleRef}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={save}
          placeholder="Task title (auto-derived from the first line)"
          className="w-full bg-transparent border-0 border-b border-border pb-2 mb-3 text-lg font-medium focus:outline-none focus:border-primary transition-colors"
        />

        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onBlur={save}
          placeholder="Task title / short description"
          rows={2}
          className="w-full bg-card border border-border rounded-md p-3 font-mono text-xs focus:outline-none focus:border-primary resize-y mb-4"
        />

        {canContinue && (
          <div className="flex gap-2 mb-6 items-center">
            <button
              disabled={continuing}
              onClick={continueTask}
              title="Resume the coordinator (last run was killed or died unexpectedly)"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-secondary border border-border hover:bg-accent disabled:opacity-40 disabled:cursor-not-allowed text-sm transition-colors"
            >
              <RotateCw size={14} className={continuing ? "animate-spin" : ""} />
              {continuing ? "Continuing…" : "Continue"}
            </button>
            <span className="text-[11px] text-fg-dim">
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
            <button
              onClick={copyCli}
              className="w-full flex items-center gap-2 px-2.5 py-2 rounded bg-background border border-border font-mono text-xs text-foreground hover:bg-accent"
            >
              <span className="text-muted-foreground">$</span>
              <span className="flex-1 text-left">{cliHint}</span>
              {copiedCmd ? <Check size={12} className="text-success" /> : <Copy size={12} className="text-fg-dim" />}
            </button>
          </div>
        )}

        {owner && (() => {
          const ownerBranch = branchByRepo[owner.repo] ?? null;
          return (
            <>
              <h3 className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Owner</h3>
              <button
                onClick={() => onSelectRun(owner)}
                className={`w-full mb-4 flex items-center gap-2 px-3 py-2.5 rounded-md text-xs font-mono transition-colors bg-primary/5 border ${
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
              </button>
            </>
          );
        })()}

        <h3 className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
          Agent tree
        </h3>
        {hasRuns ? (
          <AgentTree
            meta={meta}
            activeSessionId={activeRunId}
            onSelectRun={onSelectRun}
            onKill={handleKill}
            branchByRepo={branchByRepo}
          />
        ) : (
          <p className="text-xs text-fg-dim italic">No sessions linked yet.</p>
        )}
      </div>
    </section>
  );
}
