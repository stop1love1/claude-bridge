"use client";

import { useState } from "react";
import { ShieldAlert } from "lucide-react";
import { api } from "@/libs/client/api";
import type { Run } from "@/libs/client/types";

export function CommitReviewCard({
  taskId,
  runs,
  onActed,
}: {
  taskId: string;
  runs: Run[];
  onActed?: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const held = runs.filter((r) => r.confidence?.heldAt && !r.confidence.reviewedBy);
  if (held.length === 0) return null;

  async function act(sessionId: string, action: "ship" | "dismiss") {
    setBusy(sessionId + action);
    try {
      await api.reviewRunConfidence(taskId, sessionId, action);
      onActed?.();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 space-y-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <ShieldAlert size={14} className="text-amber-500" />
        <span>Awaiting review: {held.length} low-confidence run(s) held, not yet shipped</span>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Code is committed locally; push / merge is held until you review. &ldquo;Approve &amp;
        ship&rdquo; pushes; &ldquo;Reviewed&rdquo; only clears the hold flag (you ship later yourself via the diff view).
      </p>
      <div className="space-y-2">
        {held.map((r) => (
          <div key={r.sessionId} className="flex items-center gap-2 text-xs rounded border border-border bg-background px-2 py-1.5">
            <span className="font-mono">{r.role}</span>
            <span className="text-muted-foreground">@ {r.repo}</span>
            <span
              className={`ml-auto font-mono font-semibold px-1 py-px rounded text-[10px] ${
                r.confidence?.band === "low" ? "bg-red-500/15 text-red-500" : "bg-amber-500/15 text-amber-500"
              }`}
              title={`confidence ${r.confidence?.score}/100`}
            >
              {r.confidence?.score}
            </span>
            <button
              type="button"
              disabled={!!busy}
              onClick={() => act(r.sessionId, "ship")}
              className="rounded bg-emerald-600 px-2 py-1 text-[11px] font-medium text-white disabled:opacity-50"
            >
              {busy === r.sessionId + "ship" ? "…" : "Approve & ship"}
            </button>
            <button
              type="button"
              disabled={!!busy}
              onClick={() => act(r.sessionId, "dismiss")}
              className="rounded border border-border px-2 py-1 text-[11px] disabled:opacity-50"
            >
              Reviewed
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
