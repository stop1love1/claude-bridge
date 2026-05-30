"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  CalendarClock,
  CheckCircle2,
  Play,
  Plus,
  Power,
  Server,
  Trash2,
  Workflow as WorkflowIcon,
} from "lucide-react";
import { api } from "@/libs/client/api";
import type { Workflow, SchedulerSettings } from "@/libs/workflowStore";
import type { SchedulerStatus } from "@/libs/scheduler";
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
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const data = await api.workflows({ signal });
      if (signal?.aborted) return;
      setWorkflows(data.workflows);
      setSettings(data.settings);
      setStatus(data.status);
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

  // Slow poll to keep nextRunAt / status / lastTick fresh.
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

  return (
    <div className="flex flex-col h-screen">
      <HeaderShell active="workflows" />
      <main className="flex-1 overflow-y-auto">
        <div className="p-4 sm:p-6 max-w-3xl mx-auto space-y-5 sm:space-y-6">
          <div className="flex items-center gap-2 mb-1">
            <WorkflowIcon size={18} className="text-primary" />
            <h2 className="text-base sm:text-lg font-semibold">Quy trình</h2>
          </div>
          <p className="text-[11px] sm:text-xs text-muted-foreground">
            Tự động hoá 24/7: chạy task theo lịch (cron), tự bơm các task gắn cờ
            <span className="font-mono text-foreground"> auto </span>
            từ hàng đợi (theo trần đồng thời), và theo dõi tiến trình nền. Quy
            trình không bao giờ tự đánh dấu DONE — vẫn dừng ở READY FOR REVIEW
            chờ bạn duyệt.
          </p>

          {status && <StatusPanel status={status} />}
          {settings && <SettingsPanel settings={settings} onSaved={refresh} />}

          <CreateWorkflowForm onCreated={refresh} />

          <section className="space-y-2">
            <h3 className="text-xs uppercase tracking-wide text-muted-foreground">
              Lịch ({workflows.length})
            </h3>
            {loading ? (
              <p className="text-xs text-muted-foreground">Đang tải…</p>
            ) : workflows.length === 0 ? (
              <EmptyState
                icon={CalendarClock}
                title="Chưa có quy trình nào"
                hint="Tạo một lịch ở trên để bridge tự tạo + dispatch task định kỳ."
              />
            ) : (
              workflows.map((wf) => (
                <WorkflowRow
                  key={wf.id}
                  wf={wf}
                  onChanged={refresh}
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
        <h3 className="text-[13px] sm:text-sm font-semibold">Trạng thái 24/7</h3>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
        <dt className="text-muted-foreground">Scheduler</dt>
        <dd>{status.installed ? "đang chạy" : "chưa cài"}</dd>
        <dt className="text-muted-foreground">Tiến trình chính (lock)</dt>
        <dd>{status.isLockHolder ? "process này" : "process khác / chưa có"}</dd>
        <dt className="text-muted-foreground">Tick gần nhất</dt>
        <dd className="font-mono">{fmtTime(status.lastTickAt)}</dd>
        <dt className="text-muted-foreground">Chu kỳ tick</dt>
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
            <dt className="text-destructive">Lỗi gần nhất</dt>
            <dd className="text-destructive break-all">{status.lastError}</dd>
          </>
        )}
      </dl>

      <button
        type="button"
        onClick={() => setShowInstall((v) => !v)}
        className="mt-3 inline-flex items-center gap-1.5 text-[11px] text-primary underline-offset-2 hover:underline"
      >
        <Server size={12} /> Cài chạy nền 24/7 (Windows)
      </button>
      {showInstall && (
        <div className="mt-2 rounded-md border border-border bg-card p-3 text-[11px] text-muted-foreground space-y-2">
          <p>
            Đăng ký bridge tự khởi động khi đăng nhập + tự restart khi crash, dùng
            Windows Task Scheduler (không cần cài thêm). Mở PowerShell tại thư mục
            bridge và chạy:
          </p>
          <pre className="rounded bg-secondary p-2 font-mono text-foreground whitespace-pre-wrap break-all">
            powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1
          </pre>
          <p>
            Gỡ: <code className="font-mono text-foreground">…install-service.ps1 -Uninstall</code>.
            Chi tiết trong <code className="font-mono text-foreground">docs/24-7-setup.md</code>.
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
  const [enabled, setEnabled] = useState(settings.autoDispatchEnabled);
  const [cap, setCap] = useState(String(settings.maxConcurrentCoordinators));
  const [saving, setSaving] = useState(false);

  // Re-sync when the polled settings change (e.g. edited elsewhere).
  const lastRef = useRef(settings);
  useEffect(() => {
    if (
      lastRef.current.autoDispatchEnabled !== settings.autoDispatchEnabled ||
      lastRef.current.maxConcurrentCoordinators !== settings.maxConcurrentCoordinators
    ) {
      setEnabled(settings.autoDispatchEnabled);
      setCap(String(settings.maxConcurrentCoordinators));
      lastRef.current = settings;
    }
  }, [settings]);

  const save = async () => {
    setSaving(true);
    try {
      await api.setSchedulerSettings({
        autoDispatchEnabled: enabled,
        maxConcurrentCoordinators: Number(cap),
      });
      toast("success", "Đã lưu cài đặt auto-queue");
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
        <h3 className="text-[13px] sm:text-sm font-semibold">Tự động (auto-queue)</h3>
      </div>
      <label className="flex items-start gap-2 cursor-pointer mb-3">
        <input
          type="checkbox"
          className="mt-0.5 h-3.5 w-3.5 rounded border-border accent-primary cursor-pointer"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        <span className="text-xs">
          <span className="text-foreground font-medium">Bật bơm tự động</span>{" "}
          <span className="text-muted-foreground/80">
            — tự lấy task gắn cờ auto trong TODO và spawn coordinator, cũ nhất
            trước, tới khi chạm trần đồng thời.
          </span>
        </span>
      </label>
      <div className="flex flex-wrap items-end gap-2">
        <div className="grid gap-1.5">
          <Label htmlFor="wf-cap">Trần đồng thời (số task chạy song song)</Label>
          <Input
            id="wf-cap"
            value={cap}
            onChange={(e) => setCap(e.target.value.replace(/[^\d]/g, ""))}
            inputMode="numeric"
            className="h-8 w-24"
          />
        </div>
        <Button onClick={save} disabled={saving}>
          {saving ? "Đang lưu…" : "Lưu"}
        </Button>
        <span className="text-[11px] text-muted-foreground">1–10</span>
      </div>
    </section>
  );
}

type ScheduleKind = "interval" | "daily";
type IntervalUnit = "m" | "h" | "d";

const UNIT_MS: Record<IntervalUnit, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

function CreateWorkflowForm({ onCreated }: { onCreated: () => Promise<void> | void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [app, setApp] = useState("");
  const [kind, setKind] = useState<ScheduleKind>("interval");
  const [everyN, setEveryN] = useState("1");
  const [unit, setUnit] = useState<IntervalUnit>("h");
  const [time, setTime] = useState("09:00");
  const [submitting, setSubmitting] = useState(false);

  const buildSchedule = (): CronSchedule | null => {
    if (kind === "interval") {
      const n = Number(everyN);
      if (!Number.isFinite(n) || n <= 0) return null;
      return { kind: "interval", everyMs: n * UNIT_MS[unit] };
    }
    if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(time)) return null;
    return { kind: "daily", time };
  };

  const submit = async () => {
    const schedule = buildSchedule();
    if (!schedule) {
      toast("error", "Lịch không hợp lệ");
      return;
    }
    if (!title.trim()) {
      toast("error", "Cần tiêu đề task");
      return;
    }
    setSubmitting(true);
    try {
      await api.createWorkflow({
        name: name.trim() || title.trim(),
        schedule,
        app: app.trim() || null,
        title: title.trim(),
        body: body.trim(),
      });
      toast("success", "Đã tạo quy trình");
      setName(""); setTitle(""); setBody(""); setApp("");
      setOpen(false);
      await onCreated();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) {
    return (
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Plus size={13} /> Tạo quy trình
      </Button>
    );
  }

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-2 mb-3">
        <CalendarClock size={14} className="text-primary" />
        <h3 className="text-[13px] sm:text-sm font-semibold">Quy trình mới (cron)</h3>
      </div>
      <form
        onSubmit={(e) => { e.preventDefault(); void submit(); }}
        className="grid gap-3"
      >
        <div className="grid gap-1.5">
          <Label htmlFor="wf-name">Tên quy trình</Label>
          <Input id="wf-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="VD: Dọn log hằng đêm" className="h-8" />
        </div>

        <div className="grid gap-1.5 sm:grid-cols-[auto_1fr] sm:items-end sm:gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="wf-kind">Lịch</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as ScheduleKind)}>
              <SelectTrigger id="wf-kind" className="h-8 w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="interval">Mỗi N (interval)</SelectItem>
                <SelectItem value="daily">Hằng ngày lúc</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {kind === "interval" ? (
            <div className="flex items-end gap-2">
              <Input
                value={everyN}
                onChange={(e) => setEveryN(e.target.value.replace(/[^\d]/g, ""))}
                inputMode="numeric"
                className="h-8 w-20"
              />
              <Select value={unit} onValueChange={(v) => setUnit(v as IntervalUnit)}>
                <SelectTrigger className="h-8 w-28"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="m">phút</SelectItem>
                  <SelectItem value="h">giờ</SelectItem>
                  <SelectItem value="d">ngày</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ) : (
            <Input
              value={time}
              onChange={(e) => setTime(e.target.value)}
              placeholder="HH:MM"
              className="h-8 w-28"
            />
          )}
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="wf-app">App đích (để trống = auto)</Label>
          <Input id="wf-app" value={app} onChange={(e) => setApp(e.target.value)} placeholder="tên app, hoặc để trống" className="h-8" />
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="wf-title">Tiêu đề task</Label>
          <Input id="wf-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Dòng đầu = tiêu đề task được tạo" className="h-8" required />
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="wf-body">Nội dung task</Label>
          <Textarea
            id="wf-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={4}
            className="font-mono"
            placeholder="Mô tả công việc coordinator sẽ thực hiện mỗi lần chạy."
          />
        </div>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Huỷ</Button>
          <Button type="submit" disabled={submitting || !title.trim()}>
            {submitting ? "Đang tạo…" : "Tạo"}
          </Button>
        </div>
      </form>
    </section>
  );
}

function WorkflowRow({
  wf,
  onChanged,
  confirm,
  toast,
}: {
  wf: Workflow;
  onChanged: () => Promise<void> | void;
  confirm: ReturnType<typeof useConfirm>;
  toast: ReturnType<typeof useToast>;
}) {
  const [busy, setBusy] = useState(false);

  const toggle = async () => {
    setBusy(true);
    try {
      await api.updateWorkflow(wf.id, { enabled: !wf.enabled });
      await onChanged();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const runNow = async () => {
    setBusy(true);
    try {
      const r = await api.runWorkflowNow(wf.id);
      toast("success", `Đã tạo ${r.task.id} (auto)`);
      await onChanged();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const ok = await confirm({
      title: "Xoá quy trình này?",
      description: "Lịch dừng ngay. Các task đã tạo trước đó không bị ảnh hưởng.",
      confirmLabel: "Xoá",
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.deleteWorkflow(wf.id);
      await onChanged();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  };

  return (
    <div className={`rounded-lg border bg-card p-3 ${wf.enabled ? "border-border" : "border-border/50 opacity-70"}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded ${
            wf.enabled
              ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
              : "bg-secondary text-muted-foreground"
          }`}
        >
          {wf.enabled ? "bật" : "tắt"}
        </span>
        <span className="text-sm font-medium truncate">{wf.name}</span>
        <span className="text-[11px] text-muted-foreground font-mono">{describeSchedule(wf.schedule)}</span>
        {wf.app && <span className="text-[11px] text-muted-foreground">· {wf.app}</span>}
        <div className="flex-1" />
        <Button variant="ghost" size="xs" onClick={() => void runNow()} disabled={busy} title="Chạy ngay">
          <Play size={11} /><span className="hidden sm:inline">Chạy ngay</span>
        </Button>
        <Button variant="ghost" size="xs" onClick={() => void toggle()} disabled={busy} title={wf.enabled ? "Tắt" : "Bật"}>
          <Power size={11} /><span className="hidden sm:inline">{wf.enabled ? "Tắt" : "Bật"}</span>
        </Button>
        <Button variant="ghost" size="xs" onClick={() => void remove()} className="text-fg-dim hover:text-destructive" title="Xoá">
          <Trash2 size={11} /><span className="hidden sm:inline">Xoá</span>
        </Button>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
        <span>Lần tới: <span className="font-mono">{fmtEpoch(wf.nextRunAt)}</span></span>
        <span>· Lần cuối: <span className="font-mono">{fmtTime(wf.lastRunAt)}</span></span>
        {wf.history.length > 0 && <span>· Đã tạo {wf.history.length} task</span>}
      </div>
      <p className="mt-1 text-xs text-muted-foreground truncate">↳ {wf.title}</p>
    </div>
  );
}

export default WorkflowsPage;
