"use client";

import { useState } from "react";
import { Shield, Check, X } from "lucide-react";
import { usePermissionQueue, type PendingRequest } from "./usePermissionQueue";

const MAX_INPUT_CHARS = 600;

function summarize(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return input;
  let s: string;
  try { s = JSON.stringify(input, null, 2); } catch { s = String(input); }
  if (s.length > MAX_INPUT_CHARS) {
    return s.slice(0, MAX_INPUT_CHARS) + `\n… (${s.length - MAX_INPUT_CHARS} more chars)`;
  }
  return s;
}

/**
 * Inline panel rendered inside the SessionLog (above the composer) that
 * surfaces pending PreToolUse permission requests for THIS session as
 * Allow / Deny cards — instead of an overlay modal that blocks the
 * whole page. Queue / SSE / answer plumbing lives in
 * `usePermissionQueue`; this file just renders one card per pending
 * request.
 */
export function InlinePermissionRequests({ sessionId }: { sessionId: string | null | undefined }) {
  const { queue, answer } = usePermissionQueue(
    sessionId ? { sessionId } : { sessionId: "" },
  );

  if (!sessionId || queue.length === 0) return null;

  return (
    <div className="border-t border-border bg-warning/5 px-3 py-2 max-h-72 overflow-y-auto">
      <div className="flex items-center gap-1.5 text-[11px] text-warning font-medium mb-2">
        <Shield size={11} />
        {queue.length === 1
          ? "Claude is waiting for permission"
          : `${queue.length} permission requests pending`}
      </div>
      <ul className="space-y-1.5">
        {queue.map((req) => (
          <PermissionCard
            key={req.requestId}
            req={req}
            onAnswer={(d, remember) => void answer(req, d, remember)}
          />
        ))}
      </ul>
    </div>
  );
}

function PermissionCard({
  req,
  onAnswer,
}: {
  req: PendingRequest;
  onAnswer: (decision: "allow" | "deny", remember: boolean) => void;
}) {
  const [remember, setRemember] = useState(false);
  const summary = summarize(req.input);

  return (
    <li className="rounded-md border border-warning/30 bg-card p-2">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="text-[12px] font-medium text-foreground">
          Allow <span className="font-mono text-primary">{req.tool}</span>?
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onAnswer("deny", remember)}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] bg-destructive/15 text-destructive hover:bg-destructive/25"
          >
            <X size={10} /> Deny
          </button>
          <button
            type="button"
            onClick={() => onAnswer("allow", remember)}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Check size={10} /> Allow
          </button>
        </div>
      </div>
      {summary && (
        <pre className="text-[10.5px] font-mono bg-background border border-border rounded p-1.5 max-h-32 overflow-auto whitespace-pre-wrap wrap-break-word text-muted-foreground">
          {summary}
        </pre>
      )}
      <label className="mt-1.5 flex items-center gap-1.5 text-[10px] text-muted-foreground select-none cursor-pointer">
        <input
          type="checkbox"
          checked={remember}
          onChange={(e) => setRemember(e.target.checked)}
          className="accent-primary"
        />
        Remember <span className="font-mono">{req.tool}</span> for this session
      </label>
    </li>
  );
}
