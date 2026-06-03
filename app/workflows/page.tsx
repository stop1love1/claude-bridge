"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Pencil,
  Play,
  Plus,
  Power,
  Server,
  Trash2,
  Workflow as WorkflowIcon,
  X,
} from "lucide-react";
import { api } from "@/libs/client/api";
import type { Workflow, SchedulerSettings, StageInput } from "@/libs/workflowStore";
import type { SchedulerStatus } from "@/libs/scheduler";
import type { ActivePipelineRun } from "@/libs/pipelineEngine";
import { describeSchedule, type CronSchedule } from "@/libs/cronSchedule";
import { HeaderShell } from "../_components/HeaderShell";
import { Button } from "../_components/ui/button";
import { Input } from "../_components/ui/input";
import { Label } from "../_components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../_components/ui/select";
import { Textarea } from "../_components/ui/textarea";
import { useToast } from "../_components/Toasts";
import { useConfirm } from "../_components/ConfirmProvider";
import { EmptyState } from "../_components/ui/empty-state";

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}
function fmtEpoch(ms: number | null): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString();
}
function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

function WorkflowsPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [settings, setSettings] = useState<SchedulerSettings | null>(null);
  const [status, setStatus] = useState<SchedulerStatus | null>(null);
  const [runs, setRuns] = useState<ActivePipelineRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Workflow | "new" | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const data = await api.workflows({ signal });
      if (signal?.aborted) return;
      setWorkflows(data.workflows);
      setSettings(data.settings);
      setStatus(data.status);
      setRuns(data.runs);
    } catch (e) {
      if (!signal?.aborted) toast("error", (e as Error).message);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    const ac = new AbortController();
    void Promise.resolve().then(() => refresh(ac.signal));
    return () => ac.abort();
  }, [refresh]);

  useEffect(() => {
    const ac = new AbortController();
    let h: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (ac.signal.aborted) return;
      await refresh(ac.signal);
      if (ac.signal.aborted) return;
      h = setTimeout(() => void tick(), 5_000);
    };
    h = setTimeout(() => void tick(), 5_000);
    return () => {
      ac.abort();
      if (h) clearTimeout(h);
    };
  }, [refresh]);

  const runByWorkflow = (id: string): ActivePipelineRun | undefined =>
    runs.find((r) => r.workflowId === id && r.status === "running") ??
    runs.find((r) => r.workflowId === id);

  return (
    <div className="flex flex-col h-screen">
      <HeaderShell active="workflows" />
      <main className="flex-1 overflow-y-auto">
        <div className="p-4 sm:p-6 max-w-3xl mx-auto space-y-5 sm:space-y-6">
          <div className="flex items-center gap-2 mb-1">
            <WorkflowIcon size={18} className="text-primary" />
            <h2 className="text-base sm:text-lg font-semibold">Workflows</h2>
          </div>
          <p className="text-[11px] sm:text-xs text-muted-foreground">
            Build an ordered pipeline of stages (e.g. Code → Test → Review). A
            run flows through the stages on one task/working tree — the next
            stage starts only after the previous one finishes and passes verify.
            A failed stage retries, then blocks. Pipelines never auto-mark DONE;
            the final result stops at READY FOR REVIEW for you to confirm.
          </p>

          {status && <StatusPanel status={status} />}
          {settings && <SettingsPanel settings={settings} onSaved={refresh} />}

          {editing ? (
            <WorkflowForm
              existing={editing === "new" ? null : editing}
              onClose={() => setEditing(null)}
              onSaved={async () => { setEditing(null); await refresh(); }}
            />
          ) : (
            <Button variant="outline" onClick={() => setEditing("new")}>
              <Plus size={13} /> New workflow
            </Button>
          )}

          <section className="space-y-2">
            <h3 className="text-xs uppercase tracking-wide text-muted-foreground">
              Pipelines ({workflows.length})
            </h3>
            {loading ? (
              <p className="text-xs text-muted-foreground">Loading…</p>
            ) : workflows.length === 0 ? (
              <EmptyState
                icon={WorkflowIcon}
                title="No workflows yet"
                hint="Create a pipeline above — add stages, then Run it (or give it a cron schedule)."
              />
            ) : (
              workflows.map((wf) => (
                <WorkflowRow
                  key={wf.id}
                  wf={wf}
                  run={runByWorkflow(wf.id)}
                  onChanged={refresh}
                  onEdit={() => setEditing(wf)}
                  confirm={confirm}
                  toast={toast}
                />
              ))
            )}
          </section>
        </div>
      </main>
    </div>
  );
}

function StatusPanel({ status }: { status: SchedulerStatus }) {
  const [showInstall, setShowInstall] = useState(false);
  const healthy = status.installed && status.isLockHolder;
  return (
    <section
      className={`rounded-lg border p-4 ${
        healthy ? "border-emerald-500/30 bg-emerald-500/5" : "border-amber-500/30 bg-amber-500/5"
      }`}
    >
      <div className="flex items-center gap-2 mb-3">
        {healthy ? (
          <CheckCircle2 size={14} className="text-emerald-500" />
        ) : (
          <Activity size={14} className="text-amber-500" />
        )}
        <h3 className="text-[13px] sm:text-sm font-semibold">24/7 status</h3>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
        <dt className="text-muted-foreground">Scheduler</dt>
        <dd>{status.installed ? "running" : "not installed"}</dd>
        <dt className="text-muted-foreground">Lock holder</dt>
        <dd>{status.isLockHolder ? "this process" : "other process / none"}</dd>
        <dt className="text-muted-foreground">Last tick</dt>
        <dd className="font-mono">{fmtTime(status.lastTickAt)}</dd>
        <dt className="text-muted-foreground">Tick interval</dt>
        <dd className="font-mono">{Math.round(status.tickIntervalMs / 1000)}s</dd>
        {status.holder && (
          <>
            <dt className="text-muted-foreground">PID</dt>
            <dd className="font-mono">{status.holder.pid}</dd>
            <dt className="text-muted-foreground">Uptime</dt>
            <dd className="font-mono">{fmtUptime(status.holder.uptimeMs)}</dd>
          </>
        )}
        {status.lastError && (
          <>
            <dt className="text-destructive">Last error</dt>
            <dd className="text-destructive break-all">{status.lastError}</dd>
          </>
        )}
      </dl>

      <button
        type="button"
        onClick={() => setShowInstall((v) => !v)}
        className="mt-3 inline-flex items-center gap-1.5 text-[11px] text-primary underline-offset-2 hover:underline"
      >
        <Server size={12} /> Run 24/7 in the background (Windows)
      </button>
      {showInstall && (
        <div className="mt-2 rounded-md border border-border bg-card p-3 text-[11px] text-muted-foreground space-y-2">
          <p>
            Register the bridge to auto-start on login and auto-restart on crash
            using Windows Task Scheduler (no extra install). Open PowerShell in
            the bridge folder and run:
          </p>
          <pre className="rounded bg-secondary p-2 font-mono text-foreground whitespace-pre-wrap break-all">
            powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1
          </pre>
          <p>
            Uninstall: <code className="font-mono text-foreground">…install-service.ps1 -Uninstall</code>.
            Details in <code className="font-mono text-foreground">docs/24-7-setup.md</code>.
          </p>
        </div>
      )}
    </section>
  );
}

function SettingsPanel({
  settings,
  onSaved,
}: {
  settings: SchedulerSettings;
  onSaved: () => Promise<void> | void;
}) {
  const toast = useToast();
  const [cronEnabled, setCronEnabled] = useState(settings.cronEnabled);
  const [cap, setCap] = useState(String(settings.maxConcurrentRuns));
  const [saving, setSaving] = useState(false);

  const lastRef = useRef(settings);
  useEffect(() => {
    if (
      lastRef.current.cronEnabled !== settings.cronEnabled ||
      lastRef.current.maxConcurrentRuns !== settings.maxConcurrentRuns
    ) {
      setCronEnabled(settings.cronEnabled);
      setCap(String(settings.maxConcurrentRuns));
      lastRef.current = settings;
    }
  }, [settings]);

  const save = async () => {
    setSaving(true);
    try {
      await api.setSchedulerSettings({
        cronEnabled,
        maxConcurrentRuns: Number(cap),
      });
      toast("success", "Scheduler settings saved");
      await onSaved();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-2 mb-3">
        <Power size={14} className="text-primary" />
        <h3 className="text-[13px] sm:text-sm font-semibold">Scheduler</h3>
      </div>
      <label className="flex items-start gap-2 cursor-pointer mb-3">
        <input
          type="checkbox"
          className="mt-0.5 h-3.5 w-3.5 rounded border-border accent-primary cursor-pointer"
          checked={cronEnabled}
          onChange={(e) => setCronEnabled(e.target.checked)}
        />
        <span className="text-xs">
          <span className="text-foreground font-medium">Enable cron auto-runs</span>{" "}
          <span className="text-muted-foreground/80">
            — workflows with a schedule start automatically at their next run time.
          </span>
        </span>
      </label>
      <div className="flex flex-wrap items-end gap-2">
        <div className="grid gap-1.5">
          <Label htmlFor="wf-cap">Max concurrent runs</Label>
          <Input
            id="wf-cap"
            value={cap}
            onChange={(e) => setCap(e.target.value.replace(/[^\d]/g, ""))}
            inputMode="numeric"
            className="h-8 w-24"
          />
        </div>
        <Button onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
        <span className="text-[11px] text-muted-foreground">1–10</span>
      </div>
    </section>
  );
}

// ── Create / edit form ────────────────────────────────────────────────

type ScheduleKind = "none" | "interval" | "daily";
type IntervalUnit = "m" | "h" | "d";
const UNIT_MS: Record<IntervalUnit, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

interface StageDraft { name: string; role: string; prompt: string; verify: boolean }

function blankStage(): StageDraft {
  return { name: "", role: "", prompt: "", verify: true };
}

function scheduleToForm(s: CronSchedule | null): { kind: ScheduleKind; everyN: string; unit: IntervalUnit; time: string } {
  if (!s) return { kind: "none", everyN: "1", unit: "h", time: "09:00" };
  if (s.kind === "interval") {
    const mins = s.everyMs / 60_000;
    if (mins % 1440 === 0) return { kind: "interval", everyN: String(mins / 1440), unit: "d", time: "09:00" };
    if (mins % 60 === 0) return { kind: "interval", everyN: String(mins / 60), unit: "h", time: "09:00" };
    return { kind: "interval", everyN: String(mins), unit: "m", time: "09:00" };
  }
  return { kind: "daily", everyN: "1", unit: "h", time: s.time };
}

function WorkflowForm({
  existing,
  onClose,
  onSaved,
}: {
  existing: Workflow | null;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const toast = useToast();
  const [name, setName] = useState(existing?.name ?? "");
  const [app, setApp] = useState(existing?.app ?? "");
  const initSched = scheduleToForm(existing?.schedule ?? null);
  const [kind, setKind] = useState<ScheduleKind>(initSched.kind);
  const [everyN, setEveryN] = useState(initSched.everyN);
  const [unit, setUnit] = useState<IntervalUnit>(initSched.unit);
  const [time, setTime] = useState(initSched.time);
  const [stages, setStages] = useState<StageDraft[]>(
    existing && existing.stages.length > 0
      ? existing.stages.map((s) => ({ name: s.name, role: s.role, prompt: s.prompt, verify: s.verify }))
      : [blankStage()],
  );
  const [submitting, setSubmitting] = useState(false);

  const updateStage = (i: number, patch: Partial<StageDraft>) =>
    setStages((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  const addStage = () => setStages((prev) => [...prev, blankStage()]);
  const removeStage = (i: number) => setStages((prev) => prev.filter((_, idx) => idx !== i));
  const moveStage = (i: number, dir: -1 | 1) =>
    setStages((prev) => {
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const buildSchedule = (): CronSchedule | null => {
    if (kind === "none") return null;
    if (kind === "interval") {
      const n = Number(everyN);
      if (!Number.isFinite(n) || n <= 0) throw new Error("invalid interval");
      return { kind: "interval", everyMs: n * UNIT_MS[unit] };
    }
    if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(time)) throw new Error("invalid time (HH:MM)");
    return { kind: "daily", time };
  };

  const submit = async () => {
    if (!name.trim()) { toast("error", "Workflow name required"); return; }
    const cleanStages: StageInput[] = stages.map((s) => ({
      name: s.name.trim(),
      role: s.role.trim(),
      prompt: s.prompt.trim(),
      verify: s.verify,
    }));
    if (cleanStages.some((s) => !s.name || !s.role || !s.prompt)) {
      toast("error", "Each stage needs a name, role, and prompt");
      return;
    }
    let schedule: CronSchedule | null;
    try { schedule = buildSchedule(); } catch (e) { toast("error", (e as Error).message); return; }

    setSubmitting(true);
    try {
      if (existing) {
        await api.updateWorkflow(existing.id, {
          name: name.trim(),
          app: app.trim() || null,
          stages: cleanStages,
          schedule,
        });
        toast("success", "Workflow updated");
      } else {
        await api.createWorkflow({
          name: name.trim(),
          app: app.trim() || null,
          stages: cleanStages,
          schedule,
        });
        toast("success", "Workflow created");
      }
      await onSaved();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="rounded-lg border border-primary/30 bg-card p-4">
      <div className="flex items-center gap-2 mb-3">
        <WorkflowIcon size={14} className="text-primary" />
        <h3 className="text-[13px] sm:text-sm font-semibold">
          {existing ? "Edit workflow" : "New workflow"}
        </h3>
      </div>
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="grid gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="wf-name">Name</Label>
            <Input id="wf-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ship feature" className="h-8" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="wf-app">Target app (blank = auto-detect)</Label>
            <Input id="wf-app" value={app} onChange={(e) => setApp(e.target.value)} placeholder="app name" className="h-8" />
          </div>
        </div>

        {/* Stages editor */}
        <div className="grid gap-2">
          <div className="flex items-center justify-between">
            <Label>Stages (run in order)</Label>
            <Button type="button" size="xs" variant="ghost" onClick={addStage}>
              <Plus size={11} /> Add stage
            </Button>
          </div>
          {stages.map((s, i) => (
            <div key={i} className="rounded-md border border-border bg-muted/20 p-2.5 grid gap-2">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-mono text-muted-foreground w-5">{i + 1}.</span>
                <Input
                  value={s.name}
                  onChange={(e) => updateStage(i, { name: e.target.value })}
                  placeholder="Stage name (e.g. Code)"
                  className="h-7 flex-1"
                />
                <Input
                  value={s.role}
                  onChange={(e) => updateStage(i, { role: e.target.value })}
                  placeholder="role (e.g. coder)"
                  className="h-7 w-32 font-mono"
                />
                <button type="button" onClick={() => moveStage(i, -1)} disabled={i === 0} className="text-fg-dim hover:text-foreground disabled:opacity-30" title="Move up">
                  <ArrowUp size={13} />
                </button>
                <button type="button" onClick={() => moveStage(i, 1)} disabled={i === stages.length - 1} className="text-fg-dim hover:text-foreground disabled:opacity-30" title="Move down">
                  <ArrowDown size={13} />
                </button>
                <button type="button" onClick={() => removeStage(i)} disabled={stages.length === 1} className="text-fg-dim hover:text-destructive disabled:opacity-30" title="Remove stage">
                  <X size={13} />
                </button>
              </div>
              <Textarea
                value={s.prompt}
                onChange={(e) => updateStage(i, { prompt: e.target.value })}
                rows={2}
                className="font-mono text-xs"
                placeholder="What this stage's agent should do…"
              />
              <label className="flex items-center gap-1.5 cursor-pointer text-[11px] text-muted-foreground">
                <input
                  type="checkbox"
                  className="h-3 w-3 rounded border-border accent-primary cursor-pointer"
                  checked={s.verify}
                  onChange={(e) => updateStage(i, { verify: e.target.checked })}
                />
                Require verify to pass before the next stage
              </label>
            </div>
          ))}
        </div>

        {/* Optional schedule */}
        <div className="grid gap-1.5 sm:grid-cols-[auto_1fr] sm:items-end sm:gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="wf-kind">Schedule (optional)</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as ScheduleKind)}>
              <SelectTrigger id="wf-kind" className="h-8 w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Manual only</SelectItem>
                <SelectItem value="interval">Every N (interval)</SelectItem>
                <SelectItem value="daily">Daily at</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {kind === "interval" ? (
            <div className="flex items-end gap-2">
              <Input value={everyN} onChange={(e) => setEveryN(e.target.value.replace(/[^\d]/g, ""))} inputMode="numeric" className="h-8 w-20" />
              <Select value={unit} onValueChange={(v) => setUnit(v as IntervalUnit)}>
                <SelectTrigger className="h-8 w-28"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="m">minutes</SelectItem>
                  <SelectItem value="h">hours</SelectItem>
                  <SelectItem value="d">days</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ) : kind === "daily" ? (
            <Input value={time} onChange={(e) => setTime(e.target.value)} placeholder="HH:MM" className="h-8 w-28" />
          ) : <div />}
        </div>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={submitting}>
            {submitting ? "Saving…" : existing ? "Save" : "Create"}
          </Button>
        </div>
      </form>
    </section>
  );
}

function WorkflowRow({
  wf,
  run,
  onChanged,
  onEdit,
  confirm,
  toast,
}: {
  wf: Workflow;
  run: ActivePipelineRun | undefined;
  onChanged: () => Promise<void> | void;
  onEdit: () => void;
  confirm: ReturnType<typeof useConfirm>;
  toast: ReturnType<typeof useToast>;
}) {
  const [busy, setBusy] = useState(false);

  const toggle = async () => {
    setBusy(true);
    try { await api.updateWorkflow(wf.id, { enabled: !wf.enabled }); await onChanged(); }
    catch (e) { toast("error", (e as Error).message); }
    finally { setBusy(false); }
  };
  const runNow = async () => {
    setBusy(true);
    try { const r = await api.runWorkflow(wf.id); toast("success", `Started run → ${r.taskId}`); await onChanged(); }
    catch (e) { toast("error", (e as Error).message); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    const ok = await confirm({
      title: "Delete this workflow?",
      description: "The schedule stops immediately. Tasks it already created are unaffected.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    try { await api.deleteWorkflow(wf.id); await onChanged(); }
    catch (e) { toast("error", (e as Error).message); }
  };

  const stagesLabel = wf.stages.map((s) => s.name).join(" → ");

  return (
    <div className={`rounded-lg border bg-card p-3 ${wf.enabled ? "border-border" : "border-border/50 opacity-70"}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded ${
            wf.enabled ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" : "bg-secondary text-muted-foreground"
          }`}
        >
          {wf.enabled ? "on" : "off"}
        </span>
        <span className="text-sm font-medium truncate">{wf.name}</span>
        <span className="text-[11px] text-muted-foreground">{wf.stages.length} stage(s)</span>
        <span className="text-[11px] text-muted-foreground font-mono">
          {wf.schedule ? describeSchedule(wf.schedule) : "manual"}
        </span>
        {wf.app && <span className="text-[11px] text-muted-foreground">· {wf.app}</span>}
        <div className="flex-1" />
        <Button variant="ghost" size="xs" onClick={() => void runNow()} disabled={busy} title="Run now">
          <Play size={11} /><span className="hidden sm:inline">Run</span>
        </Button>
        <Button variant="ghost" size="xs" onClick={onEdit} disabled={busy} title="Edit">
          <Pencil size={11} /><span className="hidden sm:inline">Edit</span>
        </Button>
        <Button variant="ghost" size="xs" onClick={() => void toggle()} disabled={busy} title={wf.enabled ? "Disable" : "Enable"}>
          <Power size={11} /><span className="hidden sm:inline">{wf.enabled ? "Disable" : "Enable"}</span>
        </Button>
        <Button variant="ghost" size="xs" onClick={() => void remove()} className="text-fg-dim hover:text-destructive" title="Delete">
          <Trash2 size={11} /><span className="hidden sm:inline">Delete</span>
        </Button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground truncate">↳ {stagesLabel}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
        {run && (
          <span
            className={
              run.status === "blocked" ? "text-destructive"
              : run.status === "review" ? "text-emerald-600 dark:text-emerald-400"
              : "text-info"
            }
          >
            {run.status === "running"
              ? `running · stage ${run.stageIndex + 1}/${run.stageCount}`
              : run.status === "review"
                ? "ready for review"
                : "blocked"}
            {" · "}
            <a className="underline-offset-2 hover:underline font-mono" href={`/tasks/${run.taskId}`}>{run.taskId}</a>
          </span>
        )}
        {wf.schedule && <span>Next: <span className="font-mono">{fmtEpoch(wf.nextRunAt)}</span></span>}
        <span>Last: <span className="font-mono">{fmtTime(wf.lastRunAt)}</span></span>
        {wf.history.length > 0 && <span>· {wf.history.length} run(s)</span>}
      </div>
    </div>
  );
}

export default WorkflowsPage;
