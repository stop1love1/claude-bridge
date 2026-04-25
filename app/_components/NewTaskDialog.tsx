"use client";

import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Textarea } from "./ui/textarea";

export function NewTaskDialog({
  onCreate,
  openRef,
}: {
  onCreate: (t: { body: string }) => Promise<void>;
  openRef?: React.MutableRefObject<(() => void) | null>;
}) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const triggerOpen = () => {
    setBody("");
    setOpen(true);
  };

  useEffect(() => {
    if (!openRef) return;
    openRef.current = triggerOpen;
    return () => { if (openRef.current === triggerOpen) openRef.current = null; };
  });

  const submit = async () => {
    const trimmed = body.trim();
    if (!trimmed) return;
    setSubmitting(true);
    try {
      await onCreate({ body: trimmed });
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
