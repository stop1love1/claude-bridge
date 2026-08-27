"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, XCircle, ShieldAlert, MinusCircle, AlertTriangle } from "lucide-react";
import { api } from "@/libs/client/api";
import type { GateStatus, GateVerdict } from "@/libs/client/types";

const VERDICT_STYLE: Record<GateVerdict, { icon: typeof CheckCircle2; cls: string }> = {
  pass: { icon: CheckCircle2, cls: "bg-emerald-500/15 text-emerald-500 border-emerald-500/30" },
  fail: { icon: XCircle, cls: "bg-red-500/15 text-red-500 border-red-500/30" },
  drift: { icon: AlertTriangle, cls: "bg-orange-500/15 text-orange-500 border-orange-500/30" },
  held: { icon: ShieldAlert, cls: "bg-amber-500/15 text-amber-500 border-amber-500/30" },
  skipped: { icon: MinusCircle, cls: "bg-secondary text-fg-dim border-border" },
};

export function GateStatusBadges({
  taskId,
  refreshKey,
}: {
  taskId: string;
  refreshKey?: unknown;
}) {
  const [status, setStatus] = useState<GateStatus | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    api
      .summary(taskId)
      .then((r) => {
        if (!ac.signal.aborted) setStatus(r.gateStatus ?? null);
      })
      .catch(() => {
        if (!ac.signal.aborted) setStatus(null);
      });
    return () => ac.abort();
  }, [taskId, refreshKey]);

  if (!status || status.gates.length === 0) return null;

  return (
    <div
      className="mb-4 flex flex-wrap items-center gap-1.5"
      role="status"
      aria-label={status.allGreen ? "All gates green" : "Gate failures present"}
    >
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground mr-1">
        Gates
      </span>
      {status.gates.map((g, i) => {
        const { icon: Icon, cls } = VERDICT_STYLE[g.verdict];
        return (
          <span
            key={`${g.name}-${i}`}
            className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-mono font-medium ${cls}`}
            title={g.detail ?? `${g.name}: ${g.verdict}`}
          >
            <Icon size={10} className="shrink-0" />
            {g.name}
          </span>
        );
      })}
    </div>
  );
}
