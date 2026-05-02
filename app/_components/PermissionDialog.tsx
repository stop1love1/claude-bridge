"use client";

import { useCallback, useState } from "react";
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
import { usePermissionQueue, type PendingRequest } from "./usePermissionQueue";

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
 * Per-session modal Allow / Deny dialog. All queue / SSE / answer
 * plumbing lives in `usePermissionQueue`; this file is just the modal
 * UI for the head of the queue.
 */
export function PermissionDialog({ sessionId }: { sessionId: string | null | undefined }) {
  // Hook must be called unconditionally; pass a never-firing scope when
  // there's no session so we don't subscribe to the cross-session feed
  // by accident.
  const { queue, answer } = usePermissionQueue(
    sessionId ? { sessionId } : { sessionId: "" },
  );
  const [remember, setRemember] = useState(false);
  const current: PendingRequest | undefined = queue[0];

  const onAnswer = useCallback(
    async (decision: "allow" | "deny") => {
      if (!current) return;
      // Reset the checkbox before the next pending request renders —
      // otherwise the user's intent for request N silently carries over
      // to request N+1. (M6 from cluster F.) The `remember` flag is
      // forwarded into `answer` so usePermissionQueue can persist it
      // into its own remembered map (replaces the per-component ref
      // that lived here pre-refactor).
      setRemember(false);
      await answer(current, decision, remember);
    },
    [current, remember, answer],
  );

  if (!sessionId) return null;
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
            {"\n"}Esc keeps the popup open. Click Deny to refuse.
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
          {/* Deny is the safer default. Radix's AlertDialog already
              auto-focuses Cancel on open via onOpenAutoFocus; the
              explicit `autoFocus` is belt-and-suspenders. The visual
              shift to outline-destructive is what really tells the
              operator: Deny reads as the cautious choice, Allow as
              the deliberate one. */}
          <AlertDialogCancel
            autoFocus
            onClick={() => void onAnswer("deny")}
            className="border-destructive text-destructive hover:bg-destructive/10"
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
