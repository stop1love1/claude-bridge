import { useState } from "react";
import { Shield, Check, X } from "lucide-react";
import {
  useDecideSessionPermission,
  usePermissions,
} from "@/api/queries";
import { usePermissionStream } from "@/api/sse";
import type { PermissionRequest } from "@/api/types";

const MAX_INPUT_CHARS = 600;

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
 * Inline panel rendered inside the SessionLog (above the composer).
 * Surfaces pending PreToolUse permission requests for THIS session as
 * Allow / Deny cards instead of an overlay modal — keeps the rest of
 * the page interactive while Claude is waiting.
 */
export function InlinePermissionRequests({
  sessionId,
}: {
  sessionId: string | null | undefined;
}) {
  // Keep the SSE invalidation flowing for the whole list.
  usePermissionStream();
  const { data } = usePermissions(sessionId ?? undefined);
  const decide = useDecideSessionPermission();

  const queue: PermissionRequest[] = data?.pending ?? [];

  if (!sessionId || queue.length === 0) return null;

  const answer = (
    req: PermissionRequest,
    decision: "allow" | "deny",
    remember: boolean,
  ) => {
    void decide.mutateAsync({
      sessionId,
      requestId: req.requestId,
      body: {
        decision,
        reason: remember ? `remember:${req.tool}` : undefined,
      },
    });
  };

  return (
    <div className="border-t border-border bg-warning/5 px-3 py-2 max-h-72 overflow-y-auto">
      <div className="flex items-center gap-1.5 text-micro text-warning font-medium mb-2 uppercase tracking-wideish">
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
            onAnswer={(d, remember) => answer(req, d, remember)}
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
  req: PermissionRequest;
  onAnswer: (decision: "allow" | "deny", remember: boolean) => void;
}) {
  const [remember, setRemember] = useState(false);
  const summary = summarize(req.input);

  return (
    <li className="rounded-sm border border-warning/30 bg-card p-2">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="text-[12px] font-medium text-foreground">
          allow{" "}
          <span className="font-mono text-primary">{req.tool}</span>?
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onAnswer("deny", remember)}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-sm text-[11px] bg-destructive/15 text-destructive hover:bg-destructive/25"
          >
            <X size={10} /> Deny
          </button>
          <button
            type="button"
            onClick={() => onAnswer("allow", remember)}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-sm text-[11px] bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Check size={10} /> Allow
          </button>
        </div>
      </div>
      {summary && (
        <pre className="text-[10.5px] font-mono bg-background border border-border rounded-sm p-1.5 max-h-32 overflow-auto whitespace-pre-wrap break-words text-muted-foreground">
          {summary}
        </pre>
      )}
      <label className="mt-1.5 flex items-center gap-1.5 text-[10px] text-muted-foreground select-none cursor-pointer">
        <input
          type="checkbox"
          checked={remember}
          onChange={(e) => setRemember(e.target.checked)}
          className="accent-accent"
        />
        Remember <span className="font-mono">{req.tool}</span> for this session
      </label>
    </li>
  );
}
