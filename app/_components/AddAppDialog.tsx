"use client";

import { useEffect, useRef, useState } from "react";
import { Plus, Sparkles } from "lucide-react";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import { api } from "@/lib/client/api";
import { useToast } from "./Toasts";

interface AddAppDialogProps {
  /** Called after a successful add or auto-detect so the parent can refetch. */
  onChanged?: () => void;
  /** Imperative trigger so a parent button or hotkey can open the modal. */
  openRef?: React.MutableRefObject<(() => void) | null>;
}

/**
 * Dialog for declaring a new app in the bridge's apps registry
 * (`sessions/init.md`). Pairs with an "Auto-detect" button for one-shot
 * scanning of the parent directory.
 *
 * The two actions are exposed as a single `<div>` of buttons so callers
 * can drop them next to whatever toolbar they already have.
 */
export function AddAppDialog({ onChanged, openRef }: AddAppDialogProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  const triggerOpen = () => {
    setName("");
    setPath("");
    setDescription("");
    setOpen(true);
  };

  useEffect(() => {
    if (!openRef) return;
    openRef.current = triggerOpen;
    return () => { if (openRef.current === triggerOpen) openRef.current = null; };
  });

  useEffect(() => {
    if (open) requestAnimationFrame(() => nameRef.current?.focus());
  }, [open]);

  const submit = async () => {
    const trimmedName = name.trim();
    const trimmedPath = path.trim();
    const trimmedDescription = description.trim();
    if (!trimmedName || !trimmedPath) {
      toast("error", "Name and path are required");
      return;
    }
    setSubmitting(true);
    try {
      await api.addApp({
        name: trimmedName,
        path: trimmedPath,
        description: trimmedDescription || undefined,
      });
      // If the user didn't write a description, ask Claude to read
      // the repo and produce one. Closing the dialog and toasting
      // immediately keeps the form responsive — the scan runs in
      // the background and a follow-up toast announces the result.
      const needsScan = trimmedDescription.length === 0;
      toast(
        "success",
        needsScan ? `Added ${trimmedName}. Scanning with Claude…` : `Added ${trimmedName}`,
      );
      setOpen(false);
      onChanged?.();
      if (needsScan) {
        void (async () => {
          try {
            const r = await api.scanApp(trimmedName);
            if (r.scanned) {
              toast("info", `Claude described ${trimmedName}`);
              onChanged?.();
            }
          } catch {
            /* heuristic / blank description stays — no toast spam */
          }
        })();
      }
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const autoDetect = async () => {
    setDetecting(true);
    try {
      const r = await api.autoDetectApps();
      if (r.added.length === 0) {
        toast("info", "No new apps detected");
        return;
      }
      toast(
        "success",
        `Detected ${r.added.length} app${r.added.length === 1 ? "" : "s"}: ${r.added.map((a) => a.name).join(", ")}. Scanning with Claude…`,
      );
      onChanged?.();

      // Kick off model-grounded description scans in parallel. Each
      // scan runs `claude -p` inside the app's cwd and updates
      // bridge.json when the answer arrives. Failures are silent —
      // the heuristic description from auto-detect remains.
      const scanResults = await Promise.allSettled(
        r.added.map((a) => api.scanApp(a.name)),
      );
      const scanned = scanResults.filter(
        (s) => s.status === "fulfilled" && s.value.scanned,
      ).length;
      if (scanned > 0) {
        toast("info", `Claude described ${scanned} of ${r.added.length} new app${r.added.length === 1 ? "" : "s"}`);
        onChanged?.();
      }
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setDetecting(false);
    }
  };

  return (
    <>
      <div className="flex items-center gap-1.5">
        <Button onClick={triggerOpen} size="sm" variant="outline">
          <Plus className="h-3.5 w-3.5" /> Add app
        </Button>
        <Button
          onClick={autoDetect}
          disabled={detecting}
          size="sm"
          variant="ghost"
          title="Scan the parent directory for sibling code repos and register any not already added"
        >
          <Sparkles className={`h-3.5 w-3.5 ${detecting ? "animate-pulse" : ""}`} />
          {detecting ? "Detecting…" : "Auto-detect"}
        </Button>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add app</DialogTitle>
            <DialogDescription>
              Register a sibling project so it appears in the repo picker and the coordinator can dispatch agents to it.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-2">
            <div className="grid gap-1.5">
              <Label htmlFor="app-name">Name</Label>
              <Input
                ref={nameRef}
                id="app-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="app-web"
                autoComplete="off"
                spellCheck={false}
              />
              <p className="text-[11px] text-muted-foreground">
                Letters, digits, dots, dashes, underscores. Must start with an alphanumeric.
              </p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="app-path">Path</Label>
              <Input
                id="app-path"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="../app-web  or  /abs/path/to/app-web"
                autoComplete="off"
                spellCheck={false}
              />
              <p className="text-[11px] text-muted-foreground">
                Relative paths resolve against the bridge folder.
              </p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="app-desc">Description (optional)</Label>
              <Textarea
                id="app-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                placeholder="Frontend Next.js dashboard"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={submitting || !name.trim() || !path.trim()}>
              {submitting ? "Adding…" : "Add app"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
