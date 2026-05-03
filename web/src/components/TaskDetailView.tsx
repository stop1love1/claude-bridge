// TaskDetailView — page body for /tasks/:id. Mirrors main's
// `TaskDetail.tsx`: id chip, mark-complete + export + delete row, an
// optional completion banner, optional token-usage card, a static
// title, an optional Continue control when the last coordinator died,
// the CLI-paste callout when no runs exist, an Owner button, the
// Agent tree, and (on the right pane) the embedded SessionLog.
//
// The page wrapper (pages/TaskDetail.tsx) handles routing, breadcrumb,
// loading state, the Esc-to-back hotkey, and `?sid=` / `?activeTab=`
// URL-state.
//
// URL-driven contract:
//   * `activeSessionId` flows in from `?sid=<sessionId>`. When it's
//     null we auto-pick the most recent run and write it back via
//     `onActiveSessionIdChange` so a deep-link survives a reload.
//   * `mobileTab` flows in from `?activeTab=detail|chat`. Both panels
//     stay mounted via `display:none` on the inactive one so editor
//     state and scroll position survive a tab switch.

import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Check,
  CheckCircle2,
  Circle,
  Copy,
  Crown,
  Download,
  GitBranch,
  Hash,
  RotateCw,
  Terminal,
  Trash2,
} from "lucide-react";
import {
  useClearTask,
  useContinueTask,
  useDeleteTask,
  useKillRun,
  usePatchTask,
  useTaskMeta,
  useTaskUsage,
} from "@/api/queries";
import { useTaskEvents } from "@/api/sse";
import { type Run } from "@/api/types";
import StatusDot from "@/components/StatusDot";
import AgentTree from "@/components/AgentTree";
import { SessionLog } from "@/components/SessionLog";
import { TokenUsage, type TokenTotals } from "@/components/TokenUsage";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/Toasts";
import { useConfirm } from "@/components/ConfirmProvider";
import { exportTaskMarkdown, downloadFile } from "@/lib/exportTask";
import { relTime, durationMs } from "@/lib/time";
import { cn } from "@/lib/cn";

type MobileTab = "detail" | "chat";

interface Props {
  taskId: string;
  /** URL-driven active session id (`?sid=`). `null` = auto-pick. */
  activeSessionId?: string | null;
  onActiveSessionIdChange?: (sid: string | null) => void;
  /** URL-driven mobile tab (`?activeTab=`). Defaults to "detail". */
  mobileTab?: MobileTab;
  onMobileTabChange?: (tab: MobileTab) => void;
}

export default function TaskDetailView({
  taskId,
  activeSessionId,
  onActiveSessionIdChange,
  mobileTab = "detail",
  onMobileTabChange,
}: Props) {
  const { data: task, isLoading, error } = useTaskMeta(taskId);
  const { data: usageResp } = useTaskUsage(taskId);
  useTaskEvents(taskId);

  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();

  const patch = usePatchTask();
  const del = useDeleteTask();
  const continueTask = useContinueTask(taskId);
  const clearTask = useClearTask(taskId);
  const killRun = useKillRun();

  const [copiedId, setCopiedId] = useState(false);
  const [copiedCmd, setCopiedCmd] = useState(false);
  // Local fallback for the active session — used when the page wrapper
  // doesn't pass URL-driven props (kept so the component still works
  // standalone in tests / story).
  const [localActiveSessionId, setLocalActiveSessionId] = useState<
    string | null
  >(null);

  // Map the wire-shape TaskUsageResponse into TokenUsage's local
  // TokenTotals shape (input/output/cacheCreate/cacheRead/turns).
  const usage = useMemo<TokenTotals | null>(() => {
    const t = usageResp?.total;
    if (!t) return null;
    return {
      input: t.inputTokens,
      output: t.outputTokens,
      cacheCreate: t.cacheCreationTokens,
      cacheRead: t.cacheReadTokens,
      turns: t.turns,
    };
  }, [usageResp]);

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

  // Prefer the URL-driven id; fall back to local state, then to the
  // computed default. The URL-driven path is what the wrapper threads
  // in from `?sid=`.
  const effectiveSession =
    (activeSessionId ?? undefined) !== undefined
      ? activeSessionId
      : (localActiveSessionId ?? defaultSession);
  const setActiveSession = (sid: string | null) => {
    if (onActiveSessionIdChange) onActiveSessionIdChange(sid);
    else setLocalActiveSessionId(sid);
  };

  const activeRun = useMemo<Run | null>(() => {
    if (!task || !effectiveSession) return null;
    return task.runs.find((r) => r.sessionId === effectiveSession) ?? null;
  }, [task, effectiveSession]);

  // If the URL has no `?sid=` yet but a run roster has landed, write
  // the default session back to the URL so refresh / share preserves
  // the selection. Guarded — we only write once per task load.
  const [autoSelected, setAutoSelected] = useState(false);
  useEffect(() => {
    if (autoSelected) return;
    if (!onActiveSessionIdChange) return;
    if (activeSessionId) {
      setAutoSelected(true);
      return;
    }
    if (!task?.runs?.length) return;
    const coord =
      task.runs.find((r) => r.role === "coordinator") ??
      task.runs[task.runs.length - 1];
    setAutoSelected(true);
    onActiveSessionIdChange(coord.sessionId);
  }, [autoSelected, activeSessionId, task, onActiveSessionIdChange]);

  // clearTask is intentionally retained as a hook so the mutation key
  // stays warm — main exposes it via the kebab menu we dropped here.
  void clearTask;

  if (isLoading)
    return (
      <p className="px-6 py-10 text-small text-muted-foreground">
        Loading task…
      </p>
    );
  if (error || !task)
    return (
      <p className="px-6 py-10 text-small text-destructive">
        {error ? (error as Error).message : "Task not found"}
      </p>
    );

  const onMarkComplete = async () => {
    const next = !task.taskChecked;
    const ok = await confirm({
      title: next ? "Mark task complete?" : "Reopen task?",
      description: next
        ? "Moves the card to the done column and ticks the archive box."
        : "Drops the archive flag — task returns to its current section.",
      confirmLabel: next ? "Mark complete" : "Reopen",
    });
    if (!ok) return;
    try {
      await patch.mutateAsync({
        id: taskId,
        patch: {
          section: next ? "DONE — not yet archived" : task.taskSection,
          checked: next,
        },
      });
      toast.info(next ? "Marked complete" : "Reopened — back to DOING");
    } catch (e) {
      toast.error("Update failed", (e as Error).message);
    }
  };

  const onContinue = async () => {
    try {
      const r = await continueTask.mutateAsync(undefined);
      toast.success(
        r.action === "resumed"
          ? "Resumed coordinator"
          : "Spawned new coordinator",
      );
    } catch (e) {
      toast.error("Continue failed", (e as Error).message);
    }
  };

  const onDelete = async () => {
    const runCount = task.runs.length;
    const sessionsLine =
      runCount > 0
        ? `Also removes ${runCount} linked Claude session${runCount === 1 ? "" : "s"} from ~/.claude/projects/.`
        : `Also removes sessions/${taskId}/ metadata.`;
    const ok = await confirm({
      title: `Delete task ${taskId}?`,
      description: `"${task.taskTitle}"\n\n${sessionsLine}`,
      confirmLabel: "Delete",
      variant: "destructive",
    });
    if (!ok) return;
    try {
      const r = await del.mutateAsync(taskId);
      const msg =
        r.sessionsDeleted > 0
          ? `Task deleted (${r.sessionsDeleted} session${r.sessionsDeleted === 1 ? "" : "s"} removed${r.sessionsFailed ? `, ${r.sessionsFailed} failed` : ""})`
          : "Task deleted";
      if (r.sessionsFailed > 0) toast.error(msg);
      else toast.success(msg);
      navigate("/tasks");
    } catch (e) {
      toast.error("Delete failed", (e as Error).message);
    }
  };

  const onKillRun = async (run: Run) => {
    const ok = await confirm({
      title: `Kill ${run.role}?`,
      description: `Stops session ${run.sessionId.slice(0, 8)}… (SIGTERM, then SIGKILL after 3s).\nThe run is flipped to failed in meta.json.`,
      confirmLabel: "Kill",
      variant: "destructive",
    });
    if (!ok) return;
    try {
      await killRun.mutateAsync({ taskId, sid: run.sessionId });
      toast.info(`Killed ${run.role}`);
    } catch (e) {
      toast.error("Kill failed", (e as Error).message);
    }
  };

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(taskId);
      setCopiedId(true);
      setTimeout(() => setCopiedId(false), 1500);
    } catch {
      toast.error("Clipboard blocked");
    }
  };

  const cliHint = `Work on bridge task ${taskId}`;
  const copyCli = async () => {
    try {
      await navigator.clipboard.writeText(cliHint);
      setCopiedCmd(true);
      setTimeout(() => setCopiedCmd(false), 1500);
      toast.info("Paste into your `claude` CLI in the bridge repo");
    } catch {
      toast.error("Clipboard blocked");
    }
  };

  const onSelectRun = (r: Run) => {
    setActiveSession(r.sessionId);
    // Selecting a run on mobile flips the tab to chat so the user
    // doesn't have to make a second tap.
    if (onMobileTabChange) onMobileTabChange("chat");
  };

  const runs = task.runs ?? [];
  const hasRuns = runs.length > 0;
  const owner = runs.find((r) => r.role === "coordinator") ?? null;

  // Most recent coordinator run drives the prominent Continue CTA.
  // Mirrors main's TaskDetail: only show when the operator stopped the
  // coordinator mid-way (failed) or the process died unexpectedly
  // (reaper marked it stale). Hide when the coordinator is queued /
  // running / cleanly done.
  const lastCoordinator =
    [...runs].reverse().find((r) => r.role === "coordinator") ?? null;
  const canContinue =
    !!lastCoordinator &&
    (lastCoordinator.status === "failed" || lastCoordinator.status === "stale");

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Mobile tab bar — picks which panel takes the full height
          below. Hidden on md+ where both panels render side-by-side. */}
      <div className="flex shrink-0 border-b border-border bg-card md:hidden">
        <button
          type="button"
          onClick={() => onMobileTabChange?.("detail")}
          aria-pressed={mobileTab === "detail"}
          className={cn(
            "flex-1 border-b-2 py-1.5 text-[11.5px] font-medium transition-colors",
            mobileTab === "detail"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          Detail
        </button>
        <button
          type="button"
          onClick={() => onMobileTabChange?.("chat")}
          aria-pressed={mobileTab === "chat"}
          className={cn(
            "flex-1 truncate border-b-2 px-2 py-1.5 text-[11.5px] font-medium transition-colors",
            mobileTab === "chat"
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          Chat{activeRun ? ` · ${activeRun.role}` : ""}
        </button>
      </div>

      {/* Body grid: left column = detail; right column (md+) =
          SessionLog. Both stay mounted via display:none on the inactive
          mobile pane so editor state survives. */}
      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
        <section
          className={cn(
            "min-h-0 overflow-y-auto border-border md:flex md:border-r",
            mobileTab === "detail" ? "flex flex-col" : "hidden",
          )}
        >
          <div className="mx-auto w-full max-w-3xl p-4 sm:p-6">
            {/* Action row — id pill, age, mark-complete, export, delete. */}
            <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
              <Button
                onClick={() => void copyId()}
                variant="ghost"
                size="xs"
                title="Copy task ID"
                className="h-6 gap-1 px-1.5 font-mono text-fg-dim hover:bg-transparent hover:text-foreground"
              >
                {task.taskId}
                {copiedId ? (
                  <Check size={11} className="text-success" />
                ) : (
                  <Copy size={11} className="opacity-60" />
                )}
              </Button>
              <span className="ml-auto text-fg-dim">
                {relTime(task.createdAt)}
              </span>
              <Button
                onClick={() => void onMarkComplete()}
                variant={task.taskChecked ? "secondary" : "outline"}
                size="xs"
                title={
                  task.taskChecked
                    ? "Reopen — moves back to DOING"
                    : "Mark complete — moves to DONE"
                }
                aria-label={
                  task.taskChecked ? "Reopen task" : "Mark task complete"
                }
                className="h-6 gap-1 px-2"
              >
                {task.taskChecked ? (
                  <CheckCircle2 size={12} className="text-success" />
                ) : (
                  <Circle size={12} className="opacity-70" />
                )}
                <span className="hidden sm:inline">
                  {task.taskChecked ? "Completed" : "Mark complete"}
                </span>
              </Button>
              <Button
                onClick={() =>
                  downloadFile(
                    `${task.taskId}.md`,
                    exportTaskMarkdown(
                      {
                        id: task.taskId,
                        title: task.taskTitle,
                        body: task.taskBody,
                        section: task.taskSection,
                        status: task.taskStatus,
                        checked: task.taskChecked,
                        date: task.createdAt.slice(0, 10),
                        app: task.taskApp ?? null,
                      },
                      task,
                    ),
                  )
                }
                variant="ghost"
                size="iconSm"
                title="Export task summary as Markdown"
                className="h-6 w-6 text-fg-dim hover:text-foreground"
              >
                <Download size={13} />
              </Button>
              <Button
                onClick={() => void onDelete()}
                variant="ghost"
                size="iconSm"
                title="Delete task"
                className="h-6 w-6 text-fg-dim hover:text-destructive"
              >
                <Trash2 size={13} />
              </Button>
            </div>

            {/* Completion banner — surfaced when the user has confirmed
                the task is done. Mirrors main lines 245-256. */}
            {task.taskChecked && (
              <div
                className="mb-3 flex items-center gap-2 rounded-md border border-success/30 bg-success/10 px-3 py-2 text-xs text-success"
                role="status"
              >
                <CheckCircle2 size={14} className="shrink-0" />
                <span className="font-medium">Task completed</span>
                <span className="text-success/70">
                  · marked done by you. Per-run statuses below reflect each
                  agent&apos;s last state, independent of this checkbox.
                </span>
              </div>
            )}

            {/* Token usage card — summed across all runs. */}
            {usage && usage.turns && usage.turns > 0 && (
              <div className="mb-3 rounded-md border border-border bg-secondary/40 px-3 py-2">
                <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Token usage{" "}
                  <span className="font-normal normal-case text-fg-dim">
                    · summed across all runs
                  </span>
                </div>
                <TokenUsage totals={usage} variant="detailed" />
              </div>
            )}

            {/* Static title (read-only). */}
            <h2
              className={cn(
                "mb-3 border-b border-border pb-2 text-base font-medium leading-snug sm:text-lg",
                task.taskChecked && "text-muted-foreground line-through",
              )}
            >
              {task.taskTitle || (
                <span className="italic text-muted-foreground">
                  Untitled task
                </span>
              )}
            </h2>

            {/* Status meta row. */}
            <div className="mb-3 flex flex-wrap items-center gap-3 text-xs text-fg-dim">
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
                  app:{" "}
                  <span className="font-mono text-muted-foreground">
                    {task.taskApp}
                  </span>
                </span>
              )}
              <span>
                runs:{" "}
                <span className="tabular-nums text-muted-foreground">
                  {runs.length}
                </span>
              </span>
            </div>

            {/* Static body (read-only). */}
            {task.taskBody &&
              task.taskBody.trim() !== task.taskTitle.trim() && (
                <div className="mb-6 whitespace-pre-wrap text-small leading-relaxed text-foreground">
                  {task.taskBody.trim()}
                </div>
              )}

            {/* Continue CTA — surfaced when the last coordinator died
                or was killed. Inline secondary button + helper text,
                no tinted callout box. */}
            {canContinue && (
              <div className="mb-6 flex flex-wrap items-center gap-2">
                <Button
                  disabled={continueTask.isPending}
                  onClick={() => void onContinue()}
                  variant="secondary"
                  size="sm"
                  title="Resume the coordinator (last run was killed or died unexpectedly)"
                  className="shrink-0"
                >
                  <RotateCw
                    size={14}
                    className={continueTask.isPending ? "animate-spin" : ""}
                  />
                  {continueTask.isPending ? "Continuing…" : "Continue"}
                </Button>
                <span className="min-w-0 flex-1 text-[11px] text-fg-dim">
                  Last coordinator run ended in{" "}
                  <span className="font-mono">
                    {lastCoordinator?.status}
                  </span>{" "}
                  — pick up where it stopped.
                </span>
              </div>
            )}

            {/* CLI-paste callout — shown only when there are zero runs
                so the operator knows how to attach a Claude session. */}
            {!hasRuns && (
              <div className="mb-6 rounded-lg border border-primary/30 bg-primary/5 p-3">
                <div className="mb-2 flex items-center gap-2 text-xs font-medium text-foreground">
                  <Terminal size={13} className="text-primary" /> Assign this
                  task to a Claude session
                </div>
                <p className="mb-2 text-[11px] leading-relaxed text-muted-foreground">
                  Open <code className="font-mono text-foreground">claude</code>{" "}
                  in the bridge repo (or any sibling) and paste the line
                  below. The CLAUDE.md guide self-registers the session — it
                  will appear here as an agent.
                </p>
                <Button
                  onClick={() => void copyCli()}
                  variant="outline"
                  size="sm"
                  className="h-auto w-full justify-start py-2 font-mono text-xs"
                >
                  <span className="text-muted-foreground">$</span>
                  <span className="flex-1 text-left">{cliHint}</span>
                  {copiedCmd ? (
                    <Check size={12} className="text-success" />
                  ) : (
                    <Copy size={12} className="text-fg-dim" />
                  )}
                </Button>
              </div>
            )}

            {/* Owner button — shows the coordinator run as a one-click
                shortcut. Mirrors main lines 315-351. */}
            {owner && (
              <>
                <h3 className="mb-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                  Owner
                </h3>
                <Button
                  onClick={() => onSelectRun(owner)}
                  variant="outline"
                  size="sm"
                  className={cn(
                    "mb-4 h-auto w-full justify-start bg-primary/5 py-2.5 font-mono text-xs",
                    effectiveSession === owner.sessionId
                      ? "border-primary/60 ring-1 ring-primary/30"
                      : "border-primary/30 hover:bg-primary/10",
                  )}
                >
                  <Crown size={13} className="shrink-0 text-warning" />
                  <StatusDot status={owner.status} />
                  <span className="font-semibold text-foreground">
                    coordinator
                  </span>
                  <span className="truncate text-fg-dim">@ {owner.repo}</span>
                  {owner.startedAt && (
                    <span className="text-fg-dim">
                      · {relTime(owner.startedAt)}
                    </span>
                  )}
                  {owner.startedAt &&
                    durationMs(owner.startedAt, owner.endedAt) !== "—" && (
                      <span className="text-fg-dim">
                        · {durationMs(owner.startedAt, owner.endedAt)}
                      </span>
                    )}
                  <span className="ml-auto text-[10px] uppercase text-fg-dim">
                    {owner.status}
                  </span>
                </Button>
              </>
            )}

            {/* Agent tree heading + body. */}
            <h3 className="mb-2 text-[10px] uppercase tracking-wider text-muted-foreground">
              Agent tree
            </h3>
            {hasRuns ? (
              <AgentTree
                meta={task}
                activeSessionId={effectiveSession ?? null}
                onSelectRun={onSelectRun}
                onKill={(r) => void onKillRun(r)}
              />
            ) : (
              <p className="text-xs italic text-fg-dim">
                No sessions linked yet.
              </p>
            )}
          </div>
        </section>

        {/* Right pane — embedded SessionLog. The composer lives inside
            SessionLog (parent scope rules: don't add it here). */}
        <section
          className={cn(
            "min-h-0 min-w-0 md:flex md:flex-col",
            mobileTab === "chat" ? "flex flex-col" : "hidden",
          )}
        >
          {activeRun ? (
            <SessionLog
              sessionId={activeRun.sessionId}
              repo={activeRun.repo}
              role={activeRun.role}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center px-6 py-12 text-center text-xs text-fg-dim">
              <div>
                <Hash size={32} className="mx-auto mb-2 opacity-30" />
                <p>
                  {task.runs.length === 0
                    ? "No sessions yet — continue or clear to spawn the coordinator."
                    : "Select a run from the agent tree to view its transcript."}
                </p>
                {/* Decorative — keeps the GitBranch import live until a
                    branch selector ships. */}
                <span className="sr-only">
                  <GitBranch size={9} />
                </span>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
