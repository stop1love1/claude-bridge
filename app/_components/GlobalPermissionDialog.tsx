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
 * Cross-session Allow / Deny dialog. Subscribes to the global
 * `/api/permission` backlog + `/api/permission/stream` SSE, so a popup
 * pops on whichever page the user happens to be on, regardless of which
 * run the bridge is showing in the chat panel. The shared
 * `usePermissionQueue` hook handles backlog fetch, SSE subscribe, and
 * cross-scope deduplication: any request whose session already has a
 * session-scoped consumer mounted (e.g. `<InlinePermissionRequests>` in
 * the visible SessionLog) is skipped here so we never render two
 * dialogs for the same request.
 */
export function GlobalPermissionDialog() {
  const { queue, answer } = usePermissionQueue({ all: true });
  const [remember, setRemember] = useState(false);
  const current: PendingRequest | undefined = queue[0];

  const onAnswer = useCallback(
    async (decision: "allow" | "deny") => {
      if (!current) return;
      setRemember(false);
      await answer(current, decision, remember);
    },
    [current, remember, answer],
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
          {/* Deny is the safer default — see PermissionDialog.tsx for
              the focus-hierarchy rationale. */}
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
