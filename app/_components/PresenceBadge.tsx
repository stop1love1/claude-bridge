"use client";

import { useEffect, useState } from "react";
import { Users } from "lucide-react";
import { api } from "@/libs/client/api";

type Participant = { id: string; label: string; kind: "operator" | "guest" };

/**
 * Multi-coder Presence (Epic D). Heartbeats every 8s and shows who else is
 * on the task ("👥 N" + names). Identity is server-derived; `label` is the
 * display name this client wants to be shown as (operator omits it; a guest
 * passes the name they entered on the share gate).
 */
export function PresenceBadge({ taskId, label }: { taskId: string; label?: string }) {
  const [active, setActive] = useState<Participant[]>([]);

  useEffect(() => {
    if (!taskId) return;
    let stop = false;
    const ping = async () => {
      try {
        const r = await api.pingPresence(taskId, label);
        if (!stop) setActive(r.active);
      } catch {
        /* transient — keep trying */
      }
    };
    void ping();
    const h = setInterval(() => { void ping(); }, 8000);
    return () => { stop = true; clearInterval(h); };
  }, [taskId, label]);

  if (active.length === 0) return null;

  const names = active.map((p) => p.label).join(", ");
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-1.5 py-0.5 text-[11px] text-muted-foreground shrink-0"
      title={`On this task now: ${names}`}
    >
      <Users size={12} className="text-primary" />
      <span className="font-medium text-foreground">{active.length}</span>
      <span className="hidden sm:inline max-w-[160px] truncate">{names}</span>
    </span>
  );
}
