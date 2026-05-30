"use client";

import { useEffect, useRef, useState } from "react";
import { ShieldCheck, ShieldX, Globe, User } from "lucide-react";
import { api, type ShareRequestDto } from "@/libs/client/api";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { useToast } from "./Toasts";

const POLL_MS = 3000;

const GRANT_LABELS: Record<string, string> = {
  sendMessage: "Send prompts",
  answerPermission: "Answer permission popups",
  commit: "Commit",
  push: "Push",
};

function grantSummary(grants: ShareRequestDto["grants"]): string {
  if (!grants) return "view only";
  const on = Object.entries(grants)
    .filter(([, v]) => v)
    .map(([k]) => GRANT_LABELS[k] ?? k);
  return on.length ? on.join(", ") : "view only";
}

/**
 * Polls `/api/share/requests` every ~3s and surfaces a pending guest
 * access request as a modal. Sibling of `LoginApprovalDialog` — mounted
 * once globally so it fires on whichever page the operator is on, and
 * silently no-ops (the endpoint 401s) for guests / signed-out clients.
 */
export function ShareApprovalDialog() {
  const [queue, setQueue] = useState<ShareRequestDto[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const handledRef = useRef<Set<string>>(new Set());
  const toast = useToast();

  useEffect(() => {
    const ac = new AbortController();
    const tick = async () => {
      try {
        const { pending } = await api.shareRequests({ signal: ac.signal });
        if (ac.signal.aborted) return;
        const fresh = (pending ?? []).filter((p) => !handledRef.current.has(p.id));
        setQueue((prev) => {
          if (prev.length === fresh.length && prev.every((p, i) => p.id === fresh[i].id)) {
            return prev;
          }
          return fresh;
        });
      } catch {
        // 401 (guest / signed out) or a network blip — retry next tick.
      }
    };
    void tick();
    const handle = setInterval(() => { void tick(); }, POLL_MS);
    return () => {
      ac.abort();
      clearInterval(handle);
    };
  }, []);

  const respond = async (id: string, decision: "approved" | "denied") => {
    setBusyId(id);
    try {
      await api.answerShareRequest(id, decision);
      handledRef.current.add(id);
      setQueue((q) => q.filter((p) => p.id !== id));
      toast(
        decision === "approved" ? "success" : "info",
        decision === "approved"
          ? "Guest approved — they're getting access."
          : "Guest access denied.",
      );
    } catch (err) {
      toast("error", `Approval failed: ${(err as Error).message}`);
    } finally {
      setBusyId(null);
    }
  };

  const top = queue[0] ?? null;
  if (!top) return null;

  return (
    <Dialog open onOpenChange={() => { /* must answer; no auto-close */ }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Guest wants to open a shared task</DialogTitle>
          <DialogDescription>
            Someone opened your share link for task{" "}
            <code className="font-mono">{top.taskId}</code>
            {top.shareLabel ? ` (${top.shareLabel})` : ""}. Approve only if you
            expect this person.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2 text-xs py-2">
          <div className="flex items-start gap-2">
            <User size={13} className="text-primary mt-0.5 shrink-0" />
            <div className="min-w-0">
              <div className="font-medium text-foreground">{top.displayName || "Guest"}</div>
              <div className="text-muted-foreground break-all text-[11px]">
                {top.userAgent || "(no user-agent)"}
              </div>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <Globe size={13} className="text-primary mt-0.5 shrink-0" />
            <div className="text-muted-foreground">
              Remote IP: <code className="font-mono text-foreground">{top.ip}</code>
            </div>
          </div>
          <div className="text-[11px] rounded-md border border-warning/30 bg-warning/5 px-2 py-1.5 text-warning">
            They will be able to: <strong>{grantSummary(top.grants)}</strong> on this
            task — without logging in.
          </div>
          <div className="text-[10px] text-muted-foreground/80 mt-1">
            Requested {new Date(top.createdAt).toLocaleTimeString()} · expires{" "}
            {new Date(top.expiresAt).toLocaleTimeString()}
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button
            variant="ghost"
            onClick={() => respond(top.id, "denied")}
            disabled={busyId === top.id}
            className="text-fg-dim hover:text-destructive"
          >
            <ShieldX className="h-3.5 w-3.5" />
            Deny
          </Button>
          <Button onClick={() => respond(top.id, "approved")} disabled={busyId === top.id}>
            <ShieldCheck className="h-3.5 w-3.5" />
            Approve
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
