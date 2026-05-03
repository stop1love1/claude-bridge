// TaskDetailView — page body for /tasks/:id. Header (id + editable
// title + section pill + checkbox + action menu), body editor,
// AgentTree, embedded SessionLog for the active run, summary,
// reserved composer slot.
//
// The page wrapper (pages/TaskDetail.tsx) handles routing, breadcrumb,
// loading state, and event subscription. This file is the "inside"
// of that wrapper so it can be lifted into other surfaces (e.g. a
// modal preview) later.

import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  CheckCircle2,
  ChevronDown,
  Copy,
  MoreHorizontal,
  Play,
  RotateCw,
  Trash2,
} from "lucide-react";
import {
  useClearTask,
  useContinueTask,
  useDeleteTask,
  useKillRun,
  usePatchTask,
  useTaskMeta,
  useTaskSummary,
  patchTasksMetaCache,
} from "@/api/queries";
import { useQueryClient } from "@tanstack/react-query";
import { useTaskEvents } from "@/api/sse";
import {
  SECTIONS,
  SECTION_LABEL,
  type Run,
  type TaskSection,
} from "@/api/types";
import StatusDot from "@/components/StatusDot";
import AgentTree from "@/components/AgentTree";
import { SessionLog } from "@/components/SessionLog";
import { MessageComposer } from "@/components/MessageComposer";
import { InlinePermissionRequests } from "@/components/InlinePermissionRequests";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/Toasts";
import { useConfirm } from "@/components/ConfirmProvider";
import { cn } from "@/lib/cn";

interface Props {
  taskId: string;
}

export default function TaskDetailView({ taskId }: Props) {
  const { data: task, isLoading, error } = useTaskMeta(taskId);
  const { data: summary } = useTaskSummary(taskId);
  useTaskEvents(taskId);

  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();

  const patch = usePatchTask();
  const del = useDeleteTask();
  const continueTask = useContinueTask(taskId);
  const clearTask = useClearTask(taskId);
  const killRun = useKillRun();

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  useEffect(() => {
    if (task) {
      setTitle(task.taskTitle);
      setBody(task.taskBody);
    }
  }, [task]);

  // Default-select the most recent run when one isn't explicitly
  // chosen. Prefer a running coordinator, then the latest run by
  // startedAt.
  const defaultSession = useMemo<string | null>(() => {
    if (!task) return null;
    const running = task.runs.find((r) => r.status === "running");
    if (running) return running.sessionId;
    if (task.runs.length === 0) return null;
    return task.runs[task.runs.length - 1].sessionId;
  }, [task]);

  const effectiveSession = activeSessionId ?? defaultSession;
  const activeRun = useMemo<Run | null>(() => {
    if (!task || !effectiveSession) return null;
    return task.runs.find((r) => r.sessionId === effectiveSession) ?? null;
  }, [task, effectiveSession]);

  if (isLoading)
    return (
      <p className="px-6 py-10 font-mono text-micro tracking-wideish text-muted">
        loading task…
      </p>
    );
  if (error || !task)
    return (
      <p className="px-6 py-10 font-mono text-small text-status-blocked">
        {error ? (error as Error).message : "task not found"}
      </p>
    );

  const commit = (field: "title" | "body", value: string) => {
    const original = field === "title" ? task.taskTitle : task.taskBody;
    if (value === original) return;
    patch.mutate({ id: taskId, patch: { [field]: value } });
  };

  const moveSection = (section: TaskSection) => {
    patchTasksMetaCache(qc, (list) =>
      list.map((t) =>
        t.taskId === taskId ? { ...t, taskSection: section } : t,
      ),
    );
    patch.mutate({ id: taskId, patch: { section } });
  };

  const onArchiveToggle = async () => {
    const next = !task.taskChecked;
    const ok = await confirm({
      title: next ? "mark task done?" : "un-archive task?",
      description: next
        ? "moves the card to the done column and ticks the archive box."
        : "drops the archive flag.",
      confirmLabel: next ? "mark done" : "un-archive",
    });
    if (!ok) return;
    patch.mutate({
      id: taskId,
      patch: {
        section: "DONE — not yet archived",
        checked: next,
      },
    });
  };

  const onContinue = async () => {
    try {
      await continueTask.mutateAsync(undefined);
      toast.success("resumed", "coordinator continuing");
    } catch (e) {
      toast.error("continue failed", (e as Error).message);
    }
  };

  const onClear = async () => {
    const ok = await confirm({
      title: "clear runs?",
      description: "drops every run and respawns the coordinator.",
      confirmLabel: "clear + respawn",
      variant: "destructive",
    });
    if (!ok) return;
    try {
      await clearTask.mutateAsync();
      toast.success("cleared");
    } catch (e) {
      toast.error("clear failed", (e as Error).message);
    }
  };

  const onDelete = async () => {
    const ok = await confirm({
      title: "delete task?",
      description: "meta.json and every linked .jsonl session is removed.",
      confirmLabel: "delete",
      variant: "destructive",
    });
    if (!ok) return;
    try {
      await del.mutateAsync(taskId);
      toast.success("deleted");
      navigate("/tasks");
    } catch (e) {
      toast.error("delete failed", (e as Error).message);
    }
  };

  const onKillRun = async (run: Run) => {
    const ok = await confirm({
      title: `kill ${run.role}?`,
      description: "stops the running claude process for this run.",
      confirmLabel: "kill",
      variant: "destructive",
    });
    if (!ok) return;
    try {
      await killRun.mutateAsync({ taskId, sid: run.sessionId });
      toast.success("killed", run.role);
    } catch (e) {
      toast.error("kill failed", (e as Error).message);
    }
  };

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(taskId);
      toast.success("copied", taskId);
    } catch {
      toast.error("copy failed");
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-border bg-surface px-6 py-4">
        <div className="flex items-start gap-3">
          <span className="mt-1 font-mono text-micro tracking-wideish text-muted-2">
            {task.taskId}
          </span>

          <div className="min-w-0 flex-1">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => commit("title", title)}
              placeholder="untitled task"
              className="h-auto border-0 bg-transparent px-0 font-sans text-xl font-semibold tracking-tight text-fg shadow-none focus-visible:ring-0"
            />
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="gap-1.5">
                  {SECTION_LABEL[task.taskSection]}
                  <ChevronDown size={12} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {SECTIONS.map((s) => (
                  <DropdownMenuItem
                    key={s}
                    onClick={() => moveSection(s)}
                    className={cn(
                      task.taskSection === s && "bg-accent/10 text-accent",
                    )}
                  >
                    {SECTION_LABEL[s]}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <button
              type="button"
              onClick={() => void onArchiveToggle()}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-sm border px-2.5 py-1 font-mono text-micro uppercase tracking-wideish transition-colors",
                task.taskChecked
                  ? "border-status-done/40 bg-status-done/10 text-status-done"
                  : "border-border text-muted hover:border-border-strong hover:text-fg",
              )}
            >
              <CheckCircle2 size={12} />
              {task.taskChecked ? "archived" : "archive"}
            </button>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="iconSm" aria-label="task menu">
                  <MoreHorizontal size={14} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => void copyId()}>
                  <Copy size={12} />
                  copy id
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => void onContinue()}>
                  <Play size={12} />
                  continue
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => void onClear()}>
                  <RotateCw size={12} />
                  clear + respawn
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => void onDelete()}
                  className="text-status-blocked focus:bg-status-blocked/10 focus:text-status-blocked"
                >
                  <Trash2 size={12} />
                  delete task
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <div className="mt-2 flex items-center gap-3 font-mono text-micro tracking-wideish text-muted-2">
          <StatusDot
            status={
              task.taskStatus === "done"
                ? "done"
                : task.taskStatus === "blocked"
                  ? "failed"
                  : task.taskStatus === "doing"
                    ? "running"
                    : "queued"
            }
            label
          />
          {task.taskApp && (
            <span>
              app: <span className="text-muted">{task.taskApp}</span>
            </span>
          )}
          <span>
            created: <span className="text-muted">{task.createdAt}</span>
          </span>
          <span>
            runs: <span className="text-muted">{task.runs.length}</span>
          </span>
        </div>
      </div>

      {/* Body grid: left column = body / agent tree / summary; right
          column (lg+) = SessionLog. On smaller screens the SessionLog
          stacks below. */}
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
        <aside className="min-h-0 overflow-y-auto border-border lg:border-r">
          <div className="space-y-6 p-6">
            <section>
              <h3 className="mb-2 font-mono text-micro uppercase tracking-wideish text-muted">
                body
              </h3>
              <Textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                onBlur={() => commit("body", body)}
                rows={Math.max(6, body.split("\n").length + 1)}
                placeholder="describe the task — context, acceptance criteria, links."
                className="min-h-[120px] resize-y font-sans text-small leading-relaxed"
              />
            </section>

            <section>
              <header className="mb-2 flex items-baseline justify-between">
                <h3 className="font-mono text-micro uppercase tracking-wideish text-muted">
                  agents
                </h3>
                <span className="font-mono text-micro tabular-nums text-muted-2">
                  {String(task.runs.length).padStart(2, "0")}
                </span>
              </header>
              <AgentTree
                meta={task}
                activeSessionId={effectiveSession}
                onSelectRun={(r) => setActiveSessionId(r.sessionId)}
                onKill={(r) => void onKillRun(r)}
              />
            </section>

            {summary && typeof summary === "string" && summary.trim() && (
              <section>
                <h3 className="mb-2 font-mono text-micro uppercase tracking-wideish text-muted">
                  summary
                </h3>
                <details
                  open
                  className="rounded-sm border border-border bg-surface p-3"
                >
                  <summary className="cursor-pointer font-mono text-micro uppercase tracking-wideish text-muted-2">
                    {summary
                      .split("\n")
                      .find((l) => l.trim().length > 0)
                      ?.slice(0, 60) ?? "summary"}
                  </summary>
                  <pre className="mt-2 whitespace-pre-wrap font-mono text-small text-fg">
                    {summary}
                  </pre>
                </details>
              </section>
            )}
          </div>
        </aside>

        <section className="flex min-h-0 min-w-0 flex-col">
          {activeRun ? (
            <SessionLog
              sessionId={activeRun.sessionId}
              repo={activeRun.repo}
              role={activeRun.role}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center px-6 py-12 text-center font-mono text-micro uppercase tracking-wideish text-muted-2">
              {task.runs.length === 0
                ? "no sessions yet — continue or clear to spawn the coordinator."
                : "select a run from the agent tree to view its transcript."}
            </div>
          )}
          {activeRun ? (
            <div className="shrink-0 border-t border-border bg-surface">
              <InlinePermissionRequests sessionId={activeRun.sessionId} />
              <MessageComposer
                sessionId={activeRun.sessionId}
                repo={activeRun.repo}
                role={activeRun.role}
              />
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
