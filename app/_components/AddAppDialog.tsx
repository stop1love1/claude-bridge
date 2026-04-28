"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
import { AutoDetectDialog } from "./AutoDetectDialog";

interface AddAppDialogProps {
  /** Called after a successful add or auto-detect so the parent can refetch. */
  onChanged?: () => void;
  /** Imperative trigger so a parent button or hotkey can open the modal. */
  openRef?: React.MutableRefObject<(() => void) | null>;
}

/**
 * Dialog for declaring a new app in the bridge's apps registry
 * (`~/.claude/bridge.json`). The "Auto-detect" button next to it opens
 * the multi-step `AutoDetectDialog` which streams a scan of one or
 * more parent directories and lets the operator review + pick repos
 * to register before anything is written.
 *
 * Both actions are exposed as a single `<div>` of buttons so callers
 * can drop them next to whatever toolbar they already have.
 */
export function AddAppDialog({ onChanged, openRef }: AddAppDialogProps) {
  const [open, setOpen] = useState(false);
  const [autoDetectOpen, setAutoDetectOpen] = useState(false);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  const triggerOpen = useCallback(() => {
    setName("");
    setPath("");
    setDescription("");
    setOpen(true);
  }, []);

  useEffect(() => {
    if (!openRef) return;
    openRef.current = triggerOpen;
    return () => { if (openRef.current === triggerOpen) openRef.current = null; };
  }, [openRef, triggerOpen]);

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

  return (
    <>
      <div className="flex items-center gap-1.5">
        <Button
          onClick={triggerOpen}
          size="sm"
          variant="outline"
          title="Add app"
          aria-label="Add app"
        >
          <Plus className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Add app</span>
        </Button>
        <Button
          onClick={() => setAutoDetectOpen(true)}
          size="sm"
          variant="ghost"
          title="Scan one or more parent directories, review detected repos, then register the ones you want"
          aria-label="Auto-detect"
        >
          <Sparkles className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Auto-detect</span>
        </Button>
      </div>

      <AutoDetectDialog
        open={autoDetectOpen}
        onOpenChange={setAutoDetectOpen}
        onAdded={onChanged}
      />

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
