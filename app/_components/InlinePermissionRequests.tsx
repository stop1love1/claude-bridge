"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Shield, Check, X } from "lucide-react";

interface PendingRequest {
  requestId: string;
  tool: string;
  input: unknown;
  createdAt?: string;
}

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
 * Allow/Deny cards — instead of an overlay modal that blocks the whole
 * page. When the user is following an agent's chat and the agent pauses
 * waiting for permission, the request appears in the same conversation
 * pane, in arrival order.
 *
 * Subscribes to /api/sessions/<sid>/permission/stream (per-session SSE
 * already added in Phase C). On mount also pulls any backlog that
 * arrived before the stream connected.
 *
 * "Remember for this session" auto-resolves subsequent matching tool
 * names without showing a card (answer is still POSTed so the hook
 * resumes).
 */
export function InlinePermissionRequests({ sessionId }: { sessionId: string | null | undefined }) {
  const [queue, setQueue] = useState<PendingRequest[]>([]);
  const remembered = useRef<Map<string, "allow" | "deny">>(new Map());
  const inFlight = useRef<Set<string>>(new Set());

  useEffect(() => {
    remembered.current = new Map();
    inFlight.current = new Set();
    setQueue([]);
  }, [sessionId]);

  const respond = useCallback(
    async (req: PendingRequest, decision: "allow" | "deny") => {
      if (!sessionId) return;
      try {
        await fetch(
          `/api/sessions/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(req.requestId)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ decision, reason: decision === "deny" ? "User denied via bridge UI" : undefined }),
          },
        );
      } catch { /* the hook will time-out and fail-open */ }
      setQueue((q) => q.filter((r) => r.requestId !== req.requestId));
    },
    [sessionId],
  );

  const handle = useCallback(
    (req: PendingRequest) => {
      const memo = remembered.current.get(req.tool);
      if (memo) {
        if (inFlight.current.has(req.requestId)) return;
        inFlight.current.add(req.requestId);
        void respond(req, memo);
        return;
      }
      setQueue((q) => (q.some((r) => r.requestId === req.requestId) ? q : [...q, req]));
    },
    [respond],
  );

  useEffect(() => {
    if (!sessionId) return;
    let stopped = false;

    (async () => {
      try {
        const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/permission`);
        if (!r.ok) return;
        const j = (await r.json()) as { pending?: PendingRequest[] };
        if (stopped || !j.pending) return;
        for (const p of j.pending) handle(p);
      } catch { /* ignore */ }
    })();

    const es = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/permission/stream`);
    es.addEventListener("pending", (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data) as PendingRequest;
        handle(data);
      } catch { /* ignore */ }
    });
    es.addEventListener("answered", (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data) as { requestId: string };
        setQueue((q) => q.filter((r) => r.requestId !== data.requestId));
      } catch { /* ignore */ }
    });
    es.onerror = () => { /* browser auto-retries */ };

    return () => {
      stopped = true;
      es.close();
    };
  }, [sessionId, handle]);

  if (!sessionId || queue.length === 0) return null;

  const onAnswerCurrent = (req: PendingRequest, decision: "allow" | "deny", remember: boolean) => {
    if (remember) remembered.current.set(req.tool, decision);
    void respond(req, decision);
  };

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
          <PermissionCard key={req.requestId} req={req} onAnswer={onAnswerCurrent} />
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
  onAnswer: (req: PendingRequest, decision: "allow" | "deny", remember: boolean) => void;
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
            onClick={() => onAnswer(req, "deny", remember)}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] bg-destructive/15 text-destructive hover:bg-destructive/25"
          >
            <X size={10} /> Deny
          </button>
          <button
            type="button"
            onClick={() => onAnswer(req, "allow", remember)}
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
