"use client";

import { useEffect, useState } from "react";
import { Copy, Link2, Trash2, ShieldX, Plus, Loader2 } from "lucide-react";
import { api } from "@/libs/client/api";
import type { ShareView, ShareGrants } from "@/libs/shareStore";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { useToast } from "./Toasts";
import { useConfirm } from "./ConfirmProvider";

interface Props {
  taskId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const TTL_OPTIONS: Array<{ label: string; ms: number | null }> = [
  { label: "1 hour", ms: 3_600_000 },
  { label: "1 day", ms: 86_400_000 },
  { label: "7 days", ms: 7 * 86_400_000 },
  { label: "30 days", ms: 30 * 86_400_000 },
  { label: "Until revoked", ms: null },
];

const GRANT_FIELDS: Array<{ key: keyof ShareGrants; label: string; hint: string }> = [
  { key: "sendMessage", label: "Send prompts", hint: "drive existing runs: send messages, upload, stop" },
  { key: "spawnAgent", label: "Spawn agents", hint: "launch new agent processes against the task" },
  { key: "answerPermission", label: "Answer permission popups", hint: "Allow/Deny risky tools" },
  { key: "commit", label: "Commit code", hint: "commit the working tree" },
  { key: "push", label: "Push code", hint: "push commits (implies commit)" },
  { key: "approvePlan", label: "Approve plans", hint: "approve the intake plan so coding can proceed" },
  { key: "viewPreview", label: "View live preview", hint: "see the running app in an embedded iframe" },
];

function grantSummary(g: ShareGrants): string {
  const on = GRANT_FIELDS.filter((f) => g[f.key]).map((f) => f.label);
  return on.length ? on.join(" · ") : "View only";
}

const checkboxCls =
  "h-3.5 w-3.5 rounded border-border accent-primary cursor-pointer";

/**
 * Operator dialog to create + manage share links for one task. The raw
 * link is shown ONCE right after creation (the token is never stored in
 * plaintext, so it can't be reconstructed later). Existing shares can be
 * revoked, edited, and have individual approved devices kicked.
 */
export function ShareTaskDialog({ taskId, open, onOpenChange }: Props) {
  const toast = useToast();
  const confirm = useConfirm();
  const [shares, setShares] = useState<ShareView[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [createdLink, setCreatedLink] = useState<string | null>(null);

  // Create-form state.
  const [grants, setGrants] = useState<ShareGrants>({
    sendMessage: true,
    spawnAgent: false,
    answerPermission: true,
    commit: false,
    push: false,
    approvePlan: false,
    viewPreview: false,
  });
  const [branchMode, setBranchMode] = useState<"current" | "fixed" | "auto-create">("auto-create");
  const [branchName, setBranchName] = useState("");
  const [autoCommit, setAutoCommit] = useState(false);
  const [autoPush, setAutoPush] = useState(false);
  const [deviceTtlMs, setDeviceTtlMs] = useState<number | null>(86_400_000);
  const [expiryMs, setExpiryMs] = useState<number | null>(7 * 86_400_000);
  const [label, setLabel] = useState("");

  useEffect(() => {
    if (!open) return;
    const ac = new AbortController();
    // Inline async IIFE: every setState lands AFTER the await, so this
    // doesn't trip react-hooks/set-state-in-effect.
    void (async () => {
      try {
        const { shares: list } = await api.listShares(taskId, { signal: ac.signal });
        if (!ac.signal.aborted) { setShares(list); setLoading(false); }
      } catch {
        if (!ac.signal.aborted) setLoading(false);
      }
    })();
    return () => ac.abort();
  }, [open, taskId]);

  // push implies commit — keep the checkboxes consistent.
  const toggleGrant = (key: keyof ShareGrants, value: boolean) => {
    setGrants((g) => {
      const next = { ...g, [key]: value };
      if (key === "push" && value) next.commit = true;
      if (key === "commit" && !value) next.push = false;
      return next;
    });
  };

  const create = async () => {
    setCreating(true);
    setCreatedLink(null);
    try {
      const { share, url } = await api.createShare({
        taskId,
        grants,
        git: {
          branchMode,
          branchName: branchMode === "fixed" ? branchName.trim() : undefined,
          autoCommit,
          autoPush,
        },
        deviceTtlMs,
        expiresAt: expiryMs === null ? null : Date.now() + expiryMs,
        label: label.trim() || undefined,
      });
      setShares((s) => [share, ...s]);
      setCreatedLink(url);
      setLabel("");
      toast("success", "Share link created — copy it now, it won't be shown again.");
    } catch (err) {
      toast("error", `Create failed: ${(err as Error).message}`);
    } finally {
      setCreating(false);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast("success", "Link copied.");
    } catch {
      toast("error", "Clipboard blocked — copy manually.");
    }
  };

  const removeShare = async (id: string) => {
    const okGo = await confirm({
      title: "Delete this share link?",
      description: "The link stops working immediately and approved guests lose access.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!okGo) return;
    try {
      await api.deleteShare(id);
      setShares((s) => s.filter((x) => x.id !== id));
      toast("info", "Share deleted.");
    } catch (err) {
      toast("error", `Delete failed: ${(err as Error).message}`);
    }
  };

  const kickDevice = async (id: string, did: string) => {
    try {
      await api.revokeShareDevice(id, did);
      setShares((s) =>
        s.map((x) => (x.id === id ? { ...x, devices: x.devices.filter((d) => d.did !== did) } : x)),
      );
      toast("info", "Device revoked.");
    } catch (err) {
      toast("error", `Revoke failed: ${(err as Error).message}`);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link2 className="h-4 w-4" /> Share this task
          </DialogTitle>
          <DialogDescription>
            Create a link that lets someone open and operate on this task without
            logging in. You approve each new device once; revoke anytime.
          </DialogDescription>
        </DialogHeader>

        {/* ── Create form ─────────────────────────────────────────── */}
        <div className="grid gap-3 rounded-lg border border-border bg-muted/20 p-3 text-xs">
          <div className="font-medium text-foreground">New share link</div>

          <div className="grid gap-1.5">
            <span className="text-muted-foreground">Guest can</span>
            {GRANT_FIELDS.map((f) => (
              <label key={f.key} className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  className={checkboxCls}
                  checked={grants[f.key]}
                  onChange={(e) => toggleGrant(f.key, e.target.checked)}
                />
                <span>
                  <span className="text-foreground">{f.label}</span>{" "}
                  <span className="text-muted-foreground/70">— {f.hint}</span>
                </span>
              </label>
            ))}
          </div>

          <div className="grid gap-1.5">
            <span className="text-muted-foreground">Work lands on branch</span>
            <select
              className="rounded-md border border-border bg-background px-2 py-1 text-foreground"
              value={branchMode}
              onChange={(e) => setBranchMode(e.target.value as typeof branchMode)}
            >
              <option value="current">Current branch (no switch)</option>
              <option value="auto-create">New branch per task (claude/&lt;task-id&gt;)</option>
              <option value="fixed">Fixed branch (name below)</option>
            </select>
            {branchMode === "fixed" ? (
              <Input
                placeholder="branch name e.g. feature/guest-work"
                value={branchName}
                onChange={(e) => setBranchName(e.target.value)}
              />
            ) : null}
            <div className="flex gap-4">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" className={checkboxCls} checked={autoCommit} onChange={(e) => setAutoCommit(e.target.checked)} />
                <span>Auto-commit after each run</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" className={checkboxCls} checked={autoPush} onChange={(e) => setAutoPush(e.target.checked)} />
                <span>Auto-push</span>
              </label>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <label className="grid gap-1">
              <span className="text-muted-foreground">Remember device for</span>
              <select
                className="rounded-md border border-border bg-background px-2 py-1 text-foreground"
                value={deviceTtlMs === null ? "null" : String(deviceTtlMs)}
                onChange={(e) => setDeviceTtlMs(e.target.value === "null" ? null : Number(e.target.value))}
              >
                {TTL_OPTIONS.map((o) => (
                  <option key={o.label} value={o.ms === null ? "null" : String(o.ms)}>{o.label}</option>
                ))}
              </select>
            </label>
            <label className="grid gap-1">
              <span className="text-muted-foreground">Link expires</span>
              <select
                className="rounded-md border border-border bg-background px-2 py-1 text-foreground"
                value={expiryMs === null ? "null" : String(expiryMs)}
                onChange={(e) => setExpiryMs(e.target.value === "null" ? null : Number(e.target.value))}
              >
                <option value="3600000">In 1 hour</option>
                <option value="86400000">In 1 day</option>
                <option value="604800000">In 7 days</option>
                <option value="2592000000">In 30 days</option>
                <option value="null">Never</option>
              </select>
            </label>
          </div>

          <Input placeholder="Label (optional, e.g. 'review with Bob')" value={label} onChange={(e) => setLabel(e.target.value)} />

          <div>
            <Button onClick={create} disabled={creating}>
              {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              Create link
            </Button>
          </div>

          {createdLink ? (
            <div className="grid gap-1 rounded-md border border-success/40 bg-success/5 p-2">
              <span className="text-success font-medium">Copy this link now — it won&apos;t be shown again:</span>
              <div className="flex items-center gap-1.5">
                <code className="flex-1 truncate rounded bg-background px-2 py-1 font-mono text-[11px]">{createdLink}</code>
                <Button variant="ghost" size="sm" onClick={() => copy(createdLink)}>
                  <Copy className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ) : null}
        </div>

        {/* ── Existing shares ─────────────────────────────────────── */}
        <div className="grid gap-2">
          <div className="text-xs font-medium text-muted-foreground">
            Existing links {loading ? "" : `(${shares.length})`}
          </div>
          {shares.length === 0 && !loading ? (
            <div className="text-xs text-muted-foreground/70 py-2">No share links yet.</div>
          ) : null}
          {shares.map((s) => (
            <div key={s.id} className="rounded-lg border border-border p-2.5 text-xs grid gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium text-foreground truncate">
                    {s.label || s.id}
                    {s.revoked ? <span className="ml-2 text-destructive">· revoked</span> : null}
                    {s.expiresAt ? (
                      <span className="ml-2 text-muted-foreground/60">
                        · expires {new Date(s.expiresAt).toLocaleDateString()}
                      </span>
                    ) : null}
                  </div>
                  <div className="text-muted-foreground/80">{grantSummary(s.grants)}</div>
                  <div className="text-muted-foreground/60 text-[11px]">
                    branch: {s.git.branchMode}{s.git.branchName ? ` (${s.git.branchName})` : ""}
                    {s.git.autoPush ? " · auto-push" : s.git.autoCommit ? " · auto-commit" : ""}
                  </div>
                </div>
                <Button variant="ghost" size="sm" onClick={() => removeShare(s.id)} className="text-fg-dim hover:text-destructive shrink-0">
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
              {s.devices.length > 0 ? (
                <div className="grid gap-1 border-t border-border/60 pt-1.5">
                  <span className="text-muted-foreground/70 text-[11px]">Approved devices</span>
                  {s.devices.map((d) => (
                    <div key={d.did} className="flex items-center justify-between gap-2">
                      <span className="truncate text-foreground">
                        {d.label} <span className="text-muted-foreground/60">· {d.ip}</span>
                      </span>
                      <button
                        onClick={() => kickDevice(s.id, d.did)}
                        className="text-fg-dim hover:text-destructive shrink-0"
                        title="Revoke this device"
                      >
                        <ShieldX className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
