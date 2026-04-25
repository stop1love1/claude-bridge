"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";

interface PendingRequest {
  requestId: string;
  tool: string;
  input: unknown;
  createdAt?: string;
}

interface PermissionEvent {
  requestId: string;
  tool: string;
  input: unknown;
  createdAt?: string;
}

const MAX_INPUT_CHARS = 400;

function summarize(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return input;
  let s: string;
  try { s = JSON.stringify(input, null, 2); }
  catch { s = String(input); }
  if (s.length > MAX_INPUT_CHARS) {
    return s.slice(0, MAX_INPUT_CHARS) + `\n… (${s.length - MAX_INPUT_CHARS} more chars)`;
  }
  return s;
}

/**
 * Subscribes to `/api/sessions/<sid>/permission/stream` (SSE) and shows
 * an Allow / Deny modal whenever the claude PreToolUse hook surfaces a
 * tool request. One dialog at a time — the queue drains in arrival
 * order. A "remember for this session" checkbox lets the user
 * auto-resolve subsequent matching tool names without prompting (the
 * answer is still POSTed so the hook resumes).
 */
export function PermissionDialog({ sessionId }: { sessionId: string | null | undefined }) {
  const [queue, setQueue] = useState<PendingRequest[]>([]);
  const [remember, setRemember] = useState(false);
  const remembered = useRef<Map<string, "allow" | "deny">>(new Map());
  const inFlight = useRef<Set<string>>(new Set());

  // Reset memory when the user switches sessions.
  useEffect(() => {
    remembered.current = new Map();
    inFlight.current = new Set();
    setQueue([]);
    setRemember(false);
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
      } catch { /* the hook will time-out and fail-open; nothing else to do */ }
      setQueue((q) => q.filter((r) => r.requestId !== req.requestId));
    },
    [sessionId],
  );

  const handle = useCallback(
    (req: PendingRequest) => {
      // Auto-resolve on remembered tool decisions.
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

  // Subscribe to the SSE stream + pull any backlog on mount.
  useEffect(() => {
    if (!sessionId) return;
    let stopped = false;

    // Pull backlog first (the SSE endpoint also replays, but doing it
    // up-front means the modal can show immediately even if SSE is slow
    // to connect through the dev server).
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
        const data = JSON.parse(ev.data) as PermissionEvent;
        handle(data);
      } catch { /* ignore */ }
    });
    es.addEventListener("answered", (ev: MessageEvent) => {
      // Another tab/window already answered this request — purge it
      // from our queue so we don't show a stale modal.
      try {
        const data = JSON.parse(ev.data) as { requestId: string };
        setQueue((q) => q.filter((r) => r.requestId !== data.requestId));
      } catch { /* ignore */ }
    });
    es.onerror = () => { /* browsers auto-retry; nothing to do */ };

    return () => {
      stopped = true;
      es.close();
    };
  }, [sessionId, handle]);

  const current = queue[0];

  const onAnswer = useCallback(
    async (decision: "allow" | "deny") => {
      if (!current) return;
      if (remember) remembered.current.set(current.tool, decision);
      // Reset the checkbox before the next pending request renders —
      // otherwise the user's intent for request N silently carries over
      // to request N+1.
      setRemember(false);
      await respond(current, decision);
    },
    [current, remember, respond],
  );

  if (!current) return null;

  return (
    <AlertDialog open onOpenChange={() => { /* modal: close only via Allow/Deny */ }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Allow <span className="font-mono text-primary">{current.tool}</span>?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Claude is requesting permission to run this tool in the current session.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <pre className="text-[11px] font-mono bg-background border border-border rounded p-2 max-h-56 overflow-auto whitespace-pre-wrap wrap-break-word">
          {summarize(current.input) || "(no input)"}
        </pre>

        <label className="mt-3 flex items-center gap-2 text-[11px] text-muted-foreground select-none">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            className="accent-primary"
          />
          Remember for this session (auto-allow / auto-deny the same tool next time)
        </label>

        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => void onAnswer("deny")} className="bg-destructive text-destructive-foreground hover:bg-destructive/90 border-transparent">
            Deny
          </AlertDialogCancel>
          <AlertDialogAction onClick={() => void onAnswer("allow")}>
            Allow
          </AlertDialogAction>
        </AlertDialogFooter>

        {queue.length > 1 && (
          <p className="mt-2 text-[10px] text-muted-foreground text-right">
            +{queue.length - 1} more pending…
          </p>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}
