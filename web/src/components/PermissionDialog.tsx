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
import {
  useDecideSessionPermission,
  usePermissions,
} from "@/api/queries";
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
 * Per-session modal Allow / Deny dialog. Reads the pending list scoped
 * to the supplied sessionId, subscribes to the permission SSE so new
 * requests flow in without polling, and posts the operator's decision
 * via the scoped decide endpoint.
 *
 * The "remember for this session" checkbox is wired to the request
 * body's `reason` field — the bridge decides whether to remember based
 * on that, mirroring the legacy semantics.
 */
export function PermissionDialog({
  sessionId,
}: {
  sessionId: string | null | undefined;
}) {
  // Subscribe to SSE so new requests don't wait for the next poll.
  // Cache invalidation is handled by usePermissionStream itself.
  usePermissionStream();
  const { data } = usePermissions(sessionId ?? undefined);
  const decide = useDecideSessionPermission();
  const [remember, setRemember] = useState(false);

  const queue: PermissionRequest[] = data?.pending ?? [];
  const current = queue[0];

  const onAnswer = useCallback(
    async (decision: "allow" | "deny") => {
      if (!current || !sessionId) return;
      setRemember(false);
      await decide.mutateAsync({
        sessionId,
        requestId: current.requestId,
        body: {
          decision,
          reason: remember ? `remember:${current.tool}` : undefined,
        },
      });
    },
    [current, decide, remember, sessionId],
  );

  if (!sessionId || !current) return null;

  return (
    <AlertDialog open onOpenChange={() => undefined}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            allow{" "}
            <span className="font-mono text-primary normal-case">
              {current.tool}
            </span>
            ?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Claude is requesting permission to run this tool in the current
            session. Esc keeps the popup open. Click Deny to refuse.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <pre className="text-[11px] font-mono bg-background border border-border rounded-sm p-2 max-h-56 overflow-auto whitespace-pre-wrap break-words">
          {summarize(current.input) || "(no input)"}
        </pre>

        <label className="mt-3 flex items-center gap-2 text-[11px] text-muted-foreground select-none">
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

        {queue.length > 1 && (
          <p className="mt-2 text-[10px] text-muted-foreground text-right">
            +{queue.length - 1} more pending…
          </p>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}
