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
} from "@/components/ui/alert-dialog";
import { useAnswerPermission, usePermissions } from "@/api/queries";
import { usePermissionStream } from "@/api/sse";
import type { PermissionRequest } from "@/api/types";

const MAX_INPUT_CHARS = 400;

function summarize(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return input;
  let s: string;
  try {
    s = JSON.stringify(input, null, 2);
  } catch {
    s = String(input);
  }
  if (s.length > MAX_INPUT_CHARS) {
    return (
      s.slice(0, MAX_INPUT_CHARS) +
      `\n… (${s.length - MAX_INPUT_CHARS} more chars)`
    );
  }
  return s;
}

/**
 * Cross-session Allow / Deny dialog. Subscribes to /api/permission and
 * its SSE companion, so a popup appears regardless of which page the
 * operator is on. Always picks the OLDEST pending request — operators
 * answering one popup at a time avoids decision-fatigue race conditions
 * (a per-session inline panel still handles the visible session).
 */
export function GlobalPermissionDialog() {
  usePermissionStream();
  const { data } = usePermissions();
  const answerMut = useAnswerPermission();
  const [remember, setRemember] = useState(false);

  const queue: PermissionRequest[] = data?.pending ?? [];
  // Oldest first: requests are served createdAt ascending.
  const sorted = [...queue].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
  const current = sorted[0];

  const onAnswer = useCallback(
    async (decision: "allow" | "deny") => {
      if (!current) return;
      setRemember(false);
      await answerMut.mutateAsync({
        requestId: current.requestId,
        body: {
          decision,
          reason: remember ? `remember:${current.tool}` : undefined,
        },
      });
    },
    [current, remember, answerMut],
  );

  if (!current) return null;

  return (
    <AlertDialog open onOpenChange={() => undefined}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            allow{" "}
            <span className="font-mono text-accent normal-case">
              {current.tool}
            </span>
            ?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Claude is requesting permission to run this tool.{" "}
            <span className="font-mono text-[11px] text-muted">
              session {current.sessionId.slice(0, 8)}…
            </span>
            {"\n"}Esc keeps the popup open. Click Deny to refuse.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <pre className="text-[11px] font-mono bg-bg border border-border rounded-sm p-2 max-h-56 overflow-auto whitespace-pre-wrap break-words">
          {summarize(current.input) || "(no input)"}
        </pre>

        <label className="mt-3 flex items-center gap-2 text-[11px] text-muted select-none">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            className="accent-accent"
          />
          Remember for this session (auto-allow / auto-deny next time)
        </label>

        <AlertDialogFooter>
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

        {sorted.length > 1 && (
          <p className="mt-2 text-[10px] text-muted text-right">
            +{sorted.length - 1} more pending…
          </p>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}
