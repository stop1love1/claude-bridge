"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { TaskIntake } from "@/libs/client/types";

/**
 * Intent & Planning Gate — shared plan-review card for the operator task
 * page and the guest share page. `intake` is fed live from the parent's
 * meta (which already streams over SSE), so this card never opens its own
 * EventSource; it only fetches the plan markdown when the intake changes.
 *
 * Renders nothing unless the gate is mid-flight (`planning` /
 * `awaiting-approval` / `error`). Approve / request-changes / reject
 * buttons appear only when `canApprove` is true; otherwise the card is
 * read-only with a "waiting for the owner" note.
 */
export function PlanReviewCard({
  taskId,
  intake,
  canApprove,
  onActed,
}: {
  taskId: string;
  intake: TaskIntake | null | undefined;
  canApprove: boolean;
  onActed?: () => void;
}) {
  const [planMd, setPlanMd] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const status = intake?.status;
  const active = status === "planning" || status === "awaiting-approval" || status === "error";

  // Fetch the plan markdown whenever the gate is active. Re-runs when the
  // status changes (parent SSE drives `intake`), so a refined plan reloads.
  const lastFetchKey = useRef<string>("");
  useEffect(() => {
    if (!active) return;
    const key = `${taskId}:${status}:${intake?.questions?.length ?? 0}`;
    if (key === lastFetchKey.current) return;
    lastFetchKey.current = key;
    const ac = new AbortController();
    void (async () => {
      try {
        const r = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/plan`, { signal: ac.signal });
        if (!r.ok) return;
        const j = (await r.json()) as { planMarkdown: string | null };
        if (!ac.signal.aborted) setPlanMd(j.planMarkdown);
      } catch { /* ignore */ }
    })();
    return () => ac.abort();
  }, [taskId, status, active, intake?.questions?.length]);

  if (!active) return null;

  async function act(action: "approve" | "request-changes" | "reject", note?: string) {
    setBusy(true);
    try {
      await fetch(`/api/tasks/${encodeURIComponent(taskId)}/plan/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action,
          note,
          answers: Object.entries(answers).map(([questionId, answer]) => ({ questionId, answer })),
        }),
      });
      onActed?.();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 space-y-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        {status === "planning" && <span>🧭 Đang lập kế hoạch…</span>}
        {status === "awaiting-approval" && <span>⏳ Chờ duyệt kế hoạch</span>}
        {status === "error" && <span>⚠️ Lập kế hoạch lỗi</span>}
      </div>

      {status === "planning" && (
        <p className="text-xs text-muted-foreground">Planner đang chạy — kế hoạch sẽ hiện ở đây.</p>
      )}

      {intake?.summary && (
        <p className="text-xs text-muted-foreground italic">{intake.summary}</p>
      )}

      {status !== "planning" && planMd && (
        <div className="prose prose-sm dark:prose-invert max-w-none text-xs">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{planMd}</ReactMarkdown>
        </div>
      )}

      {status === "awaiting-approval" && (intake?.questions?.length ?? 0) > 0 && (
        <div className="space-y-2">
          {intake!.questions.map((q) => (
            <div key={q.id} className="text-xs">
              <div className="font-medium">{q.text}</div>
              {q.options && q.options.length > 0 && (
                <div className="text-[11px] text-muted-foreground">
                  Lựa chọn: {q.options.join(" · ")}
                  {q.recommended ? ` — gợi ý: ${q.recommended}` : ""}
                </div>
              )}
              <input
                className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-xs"
                placeholder={q.recommended ? `Gợi ý: ${q.recommended}` : "Trả lời…"}
                value={answers[q.id] ?? ""}
                onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
              />
            </div>
          ))}
        </div>
      )}

      {canApprove ? (
        <div className="flex flex-wrap gap-2">
          {(status === "awaiting-approval" || status === "error") && (
            <button
              type="button"
              disabled={busy}
              onClick={() => act("approve")}
              className="rounded bg-emerald-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
            >
              Duyệt &amp; code
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => act("request-changes", "operator requested changes")}
            className="rounded border border-border px-3 py-1 text-xs disabled:opacity-50"
          >
            Sửa hướng…
          </button>
          {status === "awaiting-approval" && (
            <button
              type="button"
              disabled={busy}
              onClick={() => act("reject")}
              className="rounded border border-red-500/40 px-3 py-1 text-xs text-red-500 disabled:opacity-50"
            >
              Từ chối
            </button>
          )}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Chờ chủ dự án duyệt kế hoạch.</p>
      )}
    </div>
  );
}
