"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, ShieldCheck, ShieldX, Link2 } from "lucide-react";
import { api } from "@/libs/client/api";
import type { Meta, Run } from "@/libs/client/types";
import type { ShareGrants } from "@/libs/shareStore";
import type { ActiveRun } from "./SessionLog/helpers";
import { SessionLog } from "./SessionLog";
import { PlanReviewCard } from "./PlanReviewCard";
import { LivePreview } from "./LivePreview";
import { PresenceBadge } from "./PresenceBadge";
import { useLocalStorage } from "@/libs/client/useLocalStorage";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

const loadName = (raw: string | null): string => raw ?? "";
const dumpName = (v: string): string => v;

type Phase = "gate" | "pending" | "approved" | "denied" | "error";

const NAME_KEY = "bridge_guest_name";
const POLL_MS = 2000;
const META_POLL_MS = 5000;

const GRANT_LABELS: Record<keyof ShareGrants, string> = {
  sendMessage: "send prompts",
  spawnAgent: "spawn agents",
  answerPermission: "answer permissions",
  commit: "commit",
  push: "push",
  approvePlan: "approve plans",
  viewPreview: "view preview",
};

function grantBadge(grants: ShareGrants): string {
  const on = (Object.keys(GRANT_LABELS) as Array<keyof ShareGrants>)
    .filter((k) => grants[k])
    .map((k) => GRANT_LABELS[k]);
  return on.length ? `view · ${on.join(" · ")}` : "view only";
}

/** Pick the run a guest lands on: the coordinator if present, else newest. */
function pickRun(runs: Run[]): Run | null {
  if (runs.length === 0) return null;
  const coord = runs.find((r) => r.role.toLowerCase().includes("coordinator"));
  return coord ?? runs[runs.length - 1];
}

/**
 * Guest task client for `/share/<id>/<token>`. Runs the access handshake
 * (request → operator approves → cookie), then renders the task with the
 * full `SessionLog` (live stream + permission answering + composer) —
 * scoped server-side to this one task by the share's grants.
 */
export function GuestTaskClient({ shareId, token }: { shareId: string; token: string }) {
  const [phase, setPhase] = useState<Phase>("gate");
  const [name, setName] = useLocalStorage(NAME_KEY, loadName, "", dumpName);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [grants, setGrants] = useState<ShareGrants | null>(null);
  const [reqId, setReqId] = useState<string | null>(null);
  const [error, setError] = useState<string>("");
  const [busy, setBusy] = useState(false);

  const [meta, setMeta] = useState<Meta | null>(null);
  const [selectedSid, setSelectedSid] = useState<string | null>(null);

  const onApproved = useCallback((tid: string, g: ShareGrants) => {
    setTaskId(tid);
    setGrants(g);
    setPhase("approved");
  }, []);

  const request = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const res = await api.shareAccess(shareId, token, name.trim() || undefined);
      if (res.status === "approved") {
        onApproved(res.taskId, res.grants);
      } else {
        setReqId(res.requestId);
        setTaskId(res.taskId);
        setPhase("pending");
      }
    } catch (e) {
      setError((e as Error).message || "access failed");
      setPhase("error");
    } finally {
      setBusy(false);
    }
  }, [shareId, token, name, onApproved]);

  // Poll for the operator's decision while pending.
  useEffect(() => {
    if (phase !== "pending" || !reqId) return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await api.shareAccessPoll(shareId, reqId);
        if (stop) return;
        if (r.status === "approved") onApproved(r.taskId, r.grants);
        else if (r.status === "denied") { setError(r.reason ?? ""); setPhase("denied"); }
        else if (r.status === "expired") { setPhase("gate"); setReqId(null); }
      } catch {
        /* transient — keep polling */
      }
    };
    void tick();
    const h = setInterval(() => { void tick(); }, POLL_MS);
    return () => { stop = true; clearInterval(h); };
  }, [phase, reqId, shareId, onApproved]);

  // Once approved, poll the task meta so the run list stays fresh.
  useEffect(() => {
    if (phase !== "approved" || !taskId) return;
    const ac = new AbortController();
    let stop = false;
    const tick = async () => {
      try {
        const m = await api.meta(taskId);
        if (stop) return;
        setMeta(m);
        setSelectedSid((cur) => cur ?? pickRun(m.runs)?.sessionId ?? null);
      } catch {
        /* ignore */
      }
    };
    void tick();
    const h = setInterval(() => { void tick(); }, META_POLL_MS);
    return () => { stop = true; ac.abort(); clearInterval(h); };
  }, [phase, taskId]);

  const activeRun = useMemo<ActiveRun | null>(() => {
    if (!meta) return null;
    const run = meta.runs.find((r) => r.sessionId === selectedSid) ?? null;
    if (!run || !run.repoPath) return null;
    return { sessionId: run.sessionId, repoPath: run.repoPath, role: run.role, repo: run.repo };
  }, [meta, selectedSid]);

  // ── Gate / pending / denied screens ────────────────────────────
  if (phase !== "approved") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <div className="w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-sm grid gap-4">
          <div className="flex items-center gap-2 text-foreground">
            <Link2 className="h-5 w-5 text-primary" />
            <h1 className="text-base font-semibold">Shared task access</h1>
          </div>

          {phase === "gate" ? (
            <>
              <p className="text-sm text-muted-foreground">
                Enter a name so the owner can recognize you, then request access.
                They&apos;ll approve your device once.
              </p>
              <Input
                placeholder="Your name (optional)"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void request(); }}
              />
              <Button onClick={() => void request()} disabled={busy}>
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                Request access
              </Button>
            </>
          ) : null}

          {phase === "pending" ? (
            <div className="grid gap-2 text-sm text-muted-foreground">
              <div className="flex items-center gap-2 text-foreground">
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
                Waiting for the owner to approve…
              </div>
              <p className="text-xs">Keep this tab open. This usually takes a moment.</p>
            </div>
          ) : null}

          {phase === "denied" ? (
            <div className="grid gap-2 text-sm">
              <div className="flex items-center gap-2 text-destructive">
                <ShieldX className="h-4 w-4" /> Access denied
              </div>
              {error ? <p className="text-xs text-muted-foreground">{error}</p> : null}
              <Button variant="ghost" onClick={() => setPhase("gate")}>Try again</Button>
            </div>
          ) : null}

          {phase === "error" ? (
            <div className="grid gap-2 text-sm">
              <div className="text-destructive">This share link is invalid or expired.</div>
              {error ? <p className="text-xs text-muted-foreground wrap-break-word">{error}</p> : null}
              <Button variant="ghost" onClick={() => setPhase("gate")}>Retry</Button>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  // ── Approved: scoped task view ─────────────────────────────────
  return (
    <div className="flex h-screen flex-col bg-background">
      <header className="flex items-center gap-3 border-b border-border px-4 py-2 text-sm">
        <Link2 className="h-4 w-4 text-primary shrink-0" />
        <div className="min-w-0">
          <div className="font-medium text-foreground truncate">Task {taskId}</div>
          <div className="text-[11px] text-muted-foreground">
            Guest access · {grants ? grantBadge(grants) : "view only"}
          </div>
        </div>
        {taskId && <span className="ml-auto"><PresenceBadge taskId={taskId} label={name} /></span>}
        {meta && meta.runs.length > 1 ? (
          <select
            className="ml-auto rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground max-w-[50%]"
            value={selectedSid ?? ""}
            onChange={(e) => setSelectedSid(e.target.value)}
          >
            {meta.runs.map((r) => (
              <option key={r.sessionId} value={r.sessionId}>
                {r.role} @ {r.repo}
              </option>
            ))}
          </select>
        ) : null}
      </header>
      {/* Intent & Planning Gate — guests can approve only with the grant.
          The px-4 wrapper collapses to zero height when the card is inactive. */}
      <div className="px-4 space-y-3 empty:hidden">
        {taskId && (
          <PlanReviewCard
            taskId={taskId}
            intake={meta?.intake}
            canApprove={!!grants?.approvePlan}
            onActed={() => { if (taskId) void api.meta(taskId).then(setMeta).catch(() => {}); }}
          />
        )}
        {taskId && (
          <LivePreview taskId={taskId} mode="guest" canView={!!grants?.viewPreview} />
        )}
      </div>
      <div className="min-h-0 flex-1">
        {activeRun ? (
          <SessionLog run={activeRun} repos={[]} taskId={taskId ?? undefined} />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {meta && meta.runs.length === 0 ? "No agent runs on this task yet." : "Loading…"}
          </div>
        )}
      </div>
    </div>
  );
}
