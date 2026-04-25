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

/**
 * Global PreToolUse permission dialog. Subscribes to
 * `/api/permission/stream` (the cross-session SSE) so a popup pops on
 * whichever page the user happens to be on, regardless of which run
 * the bridge is showing in the chat panel. The originating sessionId
 * travels in every event payload, so we can POST the answer back to
 * the per-session endpoint exactly like the legacy PermissionDialog.
 */

interface GlobalPendingRequest {
  sessionId: string;
  requestId: string;
  tool: string;
  input: unknown;
  createdAt?: string;
}

interface GlobalPermissionEvent extends GlobalPendingRequest {}

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

export function GlobalPermissionDialog() {
  const [queue, setQueue] = useState<GlobalPendingRequest[]>([]);
  const [remember, setRemember] = useState(false);
  // Memo is keyed by `${sessionId}:${tool}` so a remembered allow on
  // session A doesn't leak into session B answering the same tool.
  const remembered = useRef<Map<string, "allow" | "deny">>(new Map());
  const inFlight = useRef<Set<string>>(new Set());

  const respond = useCallback(
    async (req: GlobalPendingRequest, decision: "allow" | "deny") => {
      try {
        await fetch(
          `/api/sessions/${encodeURIComponent(req.sessionId)}/permission/${encodeURIComponent(req.requestId)}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              decision,
              reason: decision === "deny" ? "User denied via bridge UI" : undefined,
            }),
          },
        );
      } catch {
        /* hook fails open on timeout; nothing to do */
      }
      setQueue((q) => q.filter((r) => r.requestId !== req.requestId));
    },
    [],
  );

  const handle = useCallback(
    (req: GlobalPendingRequest) => {
      const memoKey = `${req.sessionId}:${req.tool}`;
      const memo = remembered.current.get(memoKey);
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
    const es = new EventSource(`/api/permission/stream`);
    es.addEventListener("pending", (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data) as GlobalPermissionEvent;
        handle(data);
      } catch { /* ignore */ }
    });
    es.addEventListener("answered", (ev: MessageEvent) => {
      // Another window answered — drop from queue so we don't show stale.
      try {
        const data = JSON.parse(ev.data) as { requestId: string };
        setQueue((q) => q.filter((r) => r.requestId !== data.requestId));
      } catch { /* ignore */ }
    });
    es.onerror = () => { /* browser auto-retries */ };

    return () => { es.close(); };
  }, [handle]);

  const current = queue[0];

  const onAnswer = useCallback(
    async (decision: "allow" | "deny") => {
      if (!current) return;
      if (remember) {
        remembered.current.set(`${current.sessionId}:${current.tool}`, decision);
      }
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
            Claude is requesting permission to run this tool.{" "}
            <span className="font-mono text-[11px] text-muted-foreground">
              session {current.sessionId.slice(0, 8)}…
            </span>
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
          <AlertDialogCancel
            onClick={() => void onAnswer("deny")}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90 border-transparent"
          >
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
