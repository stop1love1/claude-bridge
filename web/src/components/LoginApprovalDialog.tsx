// Polls `/api/auth/approvals` every ~3s and surfaces any pending
// device-login request as a modal. The signed-in operator can
// Approve / Deny — the new device's poll picks up the decision and
// either signs in or shows an error.
//
// Mounted once globally (next to the toast provider) so it triggers
// on whichever page the operator happens to be on. Renders nothing
// when the queue is empty.
//
// Backend gap: the Go bridge does not yet expose `/api/auth/me` or
// `/api/auth/approvals`. To avoid a 404-spam loop, we probe
// `/api/auth/me` on mount; if it 404s (or fails), we treat auth as
// "not configured" and **skip the poll entirely**. Once the Go server
// adds those endpoints, this dialog activates automatically — no UI
// changes needed.
//
// Failure modes (network down, 401 because operator just logged out)
// are silent: we just stop polling for this tick and try again next
// cycle. Preventing toast spam on transient failures.

import { useEffect, useRef, useState } from "react";
import { ShieldCheck, ShieldX, Globe, Smartphone, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/components/Toasts";

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

export function LoginApprovalDialog() {
  const [authReady, setAuthReady] = useState<null | boolean>(null);
  const [queue, setQueue] = useState<PendingApproval[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Ids the operator has already dismissed (denied or approved) — keeps
  // the dialog from re-opening on the next poll if the answer hasn't
  // fully propagated to the server side yet.
  const handledRef = useRef<Set<string>>(new Set());
  const toast = useToast();

  // Probe /api/auth/me once on mount. If auth isn't configured (the Go
  // server doesn't have these endpoints yet, or the route 404s), we
  // skip the poll entirely.
  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      try {
        const r = await fetch("/api/auth/me", {
          cache: "no-store",
          signal: ac.signal,
        });
        if (!ac.signal.aborted) setAuthReady(r.ok);
      } catch {
        if (!ac.signal.aborted) setAuthReady(false);
      }
    })();
    return () => ac.abort();
  }, []);

  useEffect(() => {
    if (!authReady) return; // null while probing, false when degraded

    const ac = new AbortController();
    const tick = async () => {
      try {
        const r = await fetch("/api/auth/approvals", {
          cache: "no-store",
          signal: ac.signal,
        });
        if (!r.ok) return;
        const data = (await r.json()) as { pending?: PendingApproval[] };
        if (ac.signal.aborted) return;
        const fresh = (data.pending ?? []).filter(
          (p) => !handledRef.current.has(p.id),
        );
        // Stable update: only setState when the list actually changed
        // so the modal doesn't flash on every poll.
        setQueue((prev) => {
          if (
            prev.length === fresh.length &&
            prev.every((p, i) => p.id === fresh[i]?.id)
          ) {
            return prev;
          }
          return fresh;
        });
      } catch {
        // abort during teardown OR a network blip — either way, keep
        // polling on the next interval tick.
      }
    };
    void tick();
    const handle = setInterval(() => {
      void tick();
    }, POLL_MS);
    return () => {
      ac.abort();
      clearInterval(handle);
    };
  }, [authReady]);

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
        toast.error("approval failed", text || String(r.status));
        return;
      }
      handledRef.current.add(id);
      setQueue((q) => q.filter((p) => p.id !== id));
      if (decision === "approved") {
        toast.success("device approved", "they're signing in.");
      } else {
        toast.info("login denied");
      }
    } catch (err) {
      toast.error("approval failed", (err as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  // Show only the OLDEST pending request — it's a critical-modal flow,
  // we don't want a queue of stacked dialogs. The next pending is
  // surfaced after the current one is resolved.
  const top = queue[0] ?? null;
  if (!authReady || !top) return null;

  // Generic CLI hint — the Go bridge equivalent of `bun run
  // approve:login <id>` hasn't been finalized yet, so we copy a stub
  // the operator can paste into a terminal once the helper lands.
  const cliHint = `bridge approve-login ${top.id}`;
  const copyCli = async () => {
    try {
      await navigator.clipboard.writeText(cliHint);
      toast.success("copied", "paste into a terminal in the bridge folder.");
    } catch {
      toast.error("copy failed", "copy the command manually.");
    }
  };

  return (
    <Dialog
      open
      onOpenChange={() => {
        /* must answer; no auto-close */
      }}
    >
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
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span>Or use the bridge CLI:</span>
            <code className="font-mono text-foreground bg-card px-1.5 py-0.5 rounded">
              {cliHint}
            </code>
            <Button
              variant="ghost"
              size="iconSm"
              onClick={copyCli}
              title="Copy command"
              aria-label="Copy CLI command"
            >
              <Copy className="h-3 w-3" />
            </Button>
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
