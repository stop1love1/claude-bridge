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

export function PermissionDialog({ sessionId }: { sessionId: string | null | undefined }) {
  const { queue, answer } = usePermissionQueue(
    sessionId ? { sessionId } : { sessionId: "" },
  );
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

  if (!sessionId) return null;
  if (!current) return null;

  return (
    <AlertDialog open onOpenChange={() => { }}>
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
          {}
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
