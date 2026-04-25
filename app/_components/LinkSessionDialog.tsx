"use client";

import { useEffect, useState } from "react";
import { Link as LinkIcon } from "lucide-react";
import type { SessionSummary, Task } from "@/lib/client/types";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

export function LinkSessionDialog({
  tasks,
  openRef,
  onLink,
}: {
  session?: SessionSummary | null;
  tasks: Task[];
  openRef: React.MutableRefObject<((s: SessionSummary) => void) | null>;
  onLink: (args: { taskId: string; sessionId: string; repo: string; role: string }) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<SessionSummary | null>(null);
  const [taskId, setTaskId] = useState("");
  const [role, setRole] = useState("coordinator");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    openRef.current = (s) => {
      setCurrent(s);
      setTaskId(s.link?.taskId ?? tasks[0]?.id ?? "");
      setRole(s.link?.role ?? "coordinator");
      setOpen(true);
    };
    return () => { if (openRef.current) openRef.current = null; };
  });

  const submit = async () => {
    if (!current || !taskId) return;
    setSubmitting(true);
    try {
      await onLink({
        taskId,
        sessionId: current.sessionId,
        repo: current.repo,
        role: role.trim() || "coordinator",
      });
      setOpen(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LinkIcon className="h-4 w-4" /> Link session to task
          </DialogTitle>
          <DialogDescription>
            Tag this Claude session with the task it&apos;s working on so it shows up under that task.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => { e.preventDefault(); submit(); }}
          className="grid gap-4"
        >
          {current && (
            <div className="rounded-md border border-border bg-muted/40 p-2.5 text-xs">
              <code className="font-mono text-muted-foreground">{current.sessionId.slice(0, 8)}…</code>
              <span className="text-muted-foreground/70"> @ {current.repo}</span>
              {current.preview && (
                <div className="mt-1 text-muted-foreground line-clamp-2">{current.preview}</div>
              )}
            </div>
          )}

          <div className="grid gap-1.5">
            <Label>Task</Label>
            <Select
              value={taskId}
              onValueChange={setTaskId}
              disabled={tasks.length === 0}
            >
              <SelectTrigger>
                <SelectValue placeholder={tasks.length === 0 ? "No tasks yet — create one first" : "Pick a task"} />
              </SelectTrigger>
              <SelectContent>
                {tasks.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    <span className="font-mono text-[10.5px] mr-1.5">{t.id}</span>
                    {t.title.slice(0, 60)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-1.5">
            <Label>Role</Label>
            <Input
              value={role}
              onChange={(e) => setRole(e.target.value)}
              placeholder="coordinator / coder / reviewer / …"
              className="font-mono"
            />
            <p className="text-[10px] text-muted-foreground">
              Free-form label — what this session is doing for the task.
            </p>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!current || !taskId || submitting}>
              {submitting ? "Linking…" : "Link"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
