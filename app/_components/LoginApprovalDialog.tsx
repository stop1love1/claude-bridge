"use client";

import { useEffect, useRef, useState } from "react";
import { ShieldCheck, ShieldX, Globe, Smartphone } from "lucide-react";
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

interface PendingApproval {
  id: string;
  email: string;
  trust: boolean;
  deviceLabel: string;
  remoteIp: string;
  userAgent: string;
  createdAt: string;
  expiresAt: string;
}

const POLL_MS = 3000;

/**
 * Polls `/api/auth/approvals` every ~3s and surfaces any pending
 * device-login request as a modal. The signed-in operator can
 * Approve / Deny — the new device's poll picks up the decision and
 * either signs in or shows an error.
 *
 * Mounted once globally (next to the toast provider) so it triggers
 * on whichever page the operator happens to be on. Renders nothing
 * when the queue is empty.
 *
 * Failure modes (network down, 401 because operator just logged out)
 * are silent: we just stop polling for this tick and try again next
 * cycle. Preventing toast spam on transient failures.
 */
export function LoginApprovalDialog() {
  const [queue, setQueue] = useState<PendingApproval[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Set of approval ids the operator has already dismissed (denied or
  // approved) — keeps the dialog from re-opening on the next poll if
  // the answer hasn't fully propagated to the server side yet.
  const handledRef = useRef<Set<string>>(new Set());
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch("/api/auth/approvals", { cache: "no-store" });
        if (!r.ok) return;
        const data = (await r.json()) as { pending?: PendingApproval[] };
        if (cancelled) return;
        const fresh = (data.pending ?? []).filter(
          (p) => !handledRef.current.has(p.id),
        );
        // Stable update: only setState when the list actually changed
        // so the modal doesn't flash on every poll.
        setQueue((prev) => {
          if (
            prev.length === fresh.length &&
            prev.every((p, i) => p.id === fresh[i].id)
          ) {
            return prev;
          }
          return fresh;
        });
      } catch {
        // network blip — keep polling.
      }
    };
    void tick();
    const handle = setInterval(() => { void tick(); }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, []);

  const respond = async (id: string, decision: "approved" | "denied") => {
    setBusyId(id);
    try {
      const r = await fetch(`/api/auth/approvals/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      if (!r.ok) {
        const text = await r.text();
        toast("error", `Approval failed: ${text || r.status}`);
        return;
      }
      handledRef.current.add(id);
      setQueue((q) => q.filter((p) => p.id !== id));
      toast(
        decision === "approved" ? "success" : "info",
        decision === "approved"
          ? "Device approved — they're signing in."
          : "Login attempt denied.",
      );
    } catch (err) {
      toast("error", `Approval failed: ${(err as Error).message}`);
    } finally {
      setBusyId(null);
    }
  };

  // Show only the OLDEST pending request — it's a critical-modal flow,
  // we don't want a queue of stacked dialogs. The next pending is
  // surfaced after the current one is resolved.
  const top = queue[0] ?? null;
  if (!top) return null;

  return (
    <Dialog open onOpenChange={() => { /* must answer; no auto-close */ }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New device sign-in request</DialogTitle>
          <DialogDescription>
            Someone is trying to sign in to Claude Bridge as{" "}
            <code className="font-mono">{top.email}</code>. Approve only if
            this is you on another device.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2 text-xs py-2">
          <div className="flex items-start gap-2">
            <Smartphone size={13} className="text-primary mt-0.5 shrink-0" />
            <div className="min-w-0">
              <div className="font-medium text-foreground">
                {top.deviceLabel}
              </div>
              <div className="text-muted-foreground break-all text-[11px]">
                {top.userAgent || "(no user-agent)"}
              </div>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <Globe size={13} className="text-primary mt-0.5 shrink-0" />
            <div className="text-muted-foreground">
              Remote IP:{" "}
              <code className="font-mono text-foreground">{top.remoteIp}</code>
            </div>
          </div>
          {top.trust ? (
            <div className="text-[11px] rounded-md border border-warning/30 bg-warning/5 px-2 py-1.5 text-warning">
              The new device asked for a 30-day trust cookie. Only approve
              if you trust this device long-term.
            </div>
          ) : null}
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
          <Button
            onClick={() => respond(top.id, "approved")}
            disabled={busyId === top.id}
          >
            <ShieldCheck className="h-3.5 w-3.5" />
            Approve
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
