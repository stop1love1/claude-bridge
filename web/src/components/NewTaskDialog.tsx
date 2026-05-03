// New-task creation dialog. Replaces the inline `<Modal>` form the
// original Board page used. Uses the radix Dialog primitive for
// keyboard handling + portal rendering, monospace body textarea
// (matches the editorial chrome), and the canonical `useCreateTask`
// mutation. Templates are skipped for v1 — the body field accepts
// freeform markdown / prose.

import { useState } from "react";
import { Plus } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useApps, useCreateTask } from "@/api/queries";
import { useToast } from "@/components/Toasts";

interface Props {
  /** Optional render-prop trigger. When omitted the dialog renders its
   *  own "+ new task" button. */
  trigger?: React.ReactNode;
  onCreated?: (taskId: string) => void;
}

const APP_AUTO = "__auto__";

export default function NewTaskDialog({ trigger, onCreated }: Props) {
  const { data: apps } = useApps();
  const create = useCreateTask();
  const toast = useToast();

  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [app, setApp] = useState<string>(APP_AUTO);

  const reset = () => {
    setTitle("");
    setBody("");
    setApp(APP_AUTO);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() && !body.trim()) {
      toast.warning("nothing to create", "fill in a title or body");
      return;
    }
    try {
      const created = await create.mutateAsync({
        title: title.trim(),
        body: body.trim(),
        app: app === APP_AUTO ? null : app,
      });
      toast.success("task created", created.id);
      reset();
      setOpen(false);
      onCreated?.(created.id);
    } catch (err) {
      toast.error("create failed", (err as Error).message);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) reset();
      }}
    >
      {trigger ? (
        <span onClick={() => setOpen(true)}>{trigger}</span>
      ) : (
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={() => setOpen(true)}
          className="gap-2"
        >
          <Plus size={14} />
          new task
        </Button>
      )}

      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>new task</DialogTitle>
          <DialogDescription>
            tasks coordinate child claude sessions. write the brief here —
            the coordinator picks the app + role from your description.
          </DialogDescription>
        </DialogHeader>

        <form
          id="new-task-form"
          onSubmit={(e) => void submit(e)}
          className="space-y-4"
        >
          <div className="space-y-1.5">
            <Label htmlFor="new-task-title">title</Label>
            <Input
              id="new-task-title"
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="short, imperative — e.g. embed dist into go binary"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="new-task-body">body</Label>
            <Textarea
              id="new-task-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={10}
              placeholder="context, links, acceptance criteria, repos involved…"
              className="min-h-[200px] font-mono text-xs leading-relaxed"
            />
          </div>

          <div className="space-y-1.5">
            <Label>target app</Label>
            <Select value={app} onValueChange={setApp}>
              <SelectTrigger>
                <SelectValue placeholder="auto (coordinator decides)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={APP_AUTO}>— auto —</SelectItem>
                {(apps?.apps ?? []).map((a) => (
                  <SelectItem key={a.name} value={a.name}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {create.isError && (
            <div className="rounded-sm border border-status-blocked/40 bg-status-blocked/10 px-3 py-2 font-mono text-micro text-status-blocked">
              {(create.error as Error).message}
            </div>
          )}
        </form>

        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => setOpen(false)}
          >
            cancel
          </Button>
          <Button
            type="submit"
            form="new-task-form"
            disabled={create.isPending}
          >
            {create.isPending ? "creating…" : "create task"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
