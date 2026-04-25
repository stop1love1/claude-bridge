"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { GitBranch, Plus } from "lucide-react";
import type { App, Repo } from "@/lib/client/types";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Label } from "./ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Textarea } from "./ui/textarea";

export const APP_AUTO = "__auto__";

export function NewTaskDialog({
  apps,
  repos = [],
  onCreate,
  openRef,
}: {
  apps: App[];
  repos?: Repo[];
  onCreate: (t: { body: string; app: string | null }) => Promise<void>;
  openRef?: React.MutableRefObject<(() => void) | null>;
}) {
  const branchByApp = new Map(repos.map((r) => [r.name, r.branch ?? null]));
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [app, setApp] = useState<string>(APP_AUTO);
  const [submitting, setSubmitting] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const triggerOpen = useCallback(() => {
    setBody("");
    setApp(APP_AUTO);
    setOpen(true);
  }, []);

  useEffect(() => {
    if (!openRef) return;
    openRef.current = triggerOpen;
    return () => { if (openRef.current === triggerOpen) openRef.current = null; };
  }, [openRef, triggerOpen]);

  const submit = async () => {
    const trimmed = body.trim();
    if (!trimmed) return;
    setSubmitting(true);
    try {
      await onCreate({
        body: trimmed,
        app: app === APP_AUTO ? null : app,
      });
      setOpen(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Button onClick={triggerOpen}>
        <Plus className="h-3.5 w-3.5" /> New task
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Describe the task</DialogTitle>
            <DialogDescription>
              The coordinator reads this as the brief. Keep the first line short
              and specific — it becomes the session title.
            </DialogDescription>
          </DialogHeader>

          <form
            onSubmit={(e) => { e.preventDefault(); submit(); }}
            className="grid gap-3"
          >
            <div className="grid gap-1.5">
              <Label htmlFor="task-app">Target app</Label>
              <Select value={app} onValueChange={setApp}>
                <SelectTrigger id="task-app" className="h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={APP_AUTO}>
                    Auto (let the coordinator decide)
                  </SelectItem>
                  {apps.map((a) => {
                    const branch = branchByApp.get(a.name);
                    return (
                      <SelectItem key={a.name} value={a.name}>
                        <span className="inline-flex items-center gap-2">
                          <span className="font-mono">{a.name}</span>
                          {branch && (
                            <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground font-mono">
                              <GitBranch size={10} className="opacity-70" />
                              {branch}
                            </span>
                          )}
                        </span>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                Pick a specific app to constrain dispatch, or leave on Auto so the heuristic chooses based on the task body.
              </p>
            </div>

            <Textarea
              ref={taRef}
              autoFocus
              required
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder="What needs to happen? First line becomes the task title; rest is context, acceptance criteria, contract links…"
              rows={8}
              className="font-mono min-h-[180px]"
            />

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!body.trim() || submitting}>
                {submitting ? "Creating…" : "Create"}
                <kbd className="ml-1 text-[9px] font-mono opacity-60">⌘↵</kbd>
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
