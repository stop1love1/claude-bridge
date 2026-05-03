// New-task creation dialog. Replaces the inline `<Modal>` form the
// original Board page used. Uses the radix Dialog primitive for
// keyboard handling + portal rendering, monospace body textarea
// (matches the editorial chrome), and the canonical `useCreateTask`
// mutation.
//
// Wave-3B port from main: built-in + user task templates, repo
// branch annotation in the app picker, Cmd/Ctrl+Enter submit hotkey,
// imperative `openRef` so callers (Tasks page Cmd+N) can pop the
// dialog without rendering a hidden trigger button.

import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { Bookmark, BookmarkPlus, GitBranch, Plus, X } from "lucide-react";
// Note: title is no longer collected as a separate field — we derive it
// from the first non-empty line of the body at submit time. The
// imported `Input` is still used by the "Save as template" pill.
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
import { useApps, useCreateTask, useRepos } from "@/api/queries";
import { useToast } from "@/components/Toasts";
import {
  type TaskTemplate,
  BUILTIN_TEMPLATES,
  addUserTemplate,
  loadUserTemplates,
  removeUserTemplate,
} from "@/lib/taskTemplates";

interface Props {
  /** Optional render-prop trigger. When omitted the dialog renders its
   *  own "+ new task" button. */
  trigger?: React.ReactNode;
  onCreated?: (taskId: string) => void;
}

export interface NewTaskDialogHandle {
  open: () => void;
}

const APP_AUTO = "__auto__";

const NewTaskDialog = forwardRef<NewTaskDialogHandle, Props>(
  function NewTaskDialog({ trigger, onCreated }, ref) {
    const [open, setOpen] = useState(false);

    useImperativeHandle(ref, () => ({ open: () => setOpen(true) }), []);

    return (
      <Dialog open={open} onOpenChange={setOpen}>
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
            New task
          </Button>
        )}
        {/* Body only mounts while open so localStorage reads + lazy
         *  state initializers fire on every fresh open (no reset
         *  effect needed). */}
        {open && (
          <NewTaskDialogBody
            onClose={() => setOpen(false)}
            onCreated={onCreated}
          />
        )}
      </Dialog>
    );
  },
);

export default NewTaskDialog;

function NewTaskDialogBody({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated?: (taskId: string) => void;
}) {
  const { data: appsData } = useApps();
  const { data: reposData } = useRepos();
  const apps = appsData?.apps ?? [];
  const repos = reposData?.repos ?? [];
  const create = useCreateTask();
  const toast = useToast();

  const branchByApp = useMemo(
    () => new Map(repos.map((r) => [r.name, r.branch ?? null])),
    [repos],
  );

  const [body, setBody] = useState("");
  const [app, setApp] = useState<string>(APP_AUTO);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  // Derive a concise title from the first non-empty line of the body.
  // Mirrors the behaviour main relies on so the operator only fills
  // one field instead of two.
  const deriveTitle = (raw: string): string => {
    const firstLine = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    return (firstLine ?? "").slice(0, 200);
  };

  // Lazy initialiser — runs once on mount (i.e. when the dialog
  // opens). Safe to read localStorage here because this component
  // only mounts on the client.
  const [templates, setTemplates] = useState<TaskTemplate[]>(() => [
    ...BUILTIN_TEMPLATES,
    ...loadUserTemplates(),
  ]);
  const [savingTpl, setSavingTpl] = useState(false);
  const [tplLabel, setTplLabel] = useState("");

  const builtinTemplates = useMemo(
    () => templates.filter((t) => t.builtin),
    [templates],
  );
  const userTemplates = useMemo(
    () => templates.filter((t) => !t.builtin),
    [templates],
  );

  const applyTemplate = useCallback((t: TaskTemplate) => {
    // The whole template body lands in the textarea verbatim — main
    // derives the title from the first non-empty line at submit, so
    // there's nothing else to split.
    setBody(t.body);
    setTimeout(() => bodyRef.current?.focus(), 0);
  }, []);

  const handleSaveTemplate = useCallback(() => {
    const label = tplLabel.trim();
    const text = body.trim();
    if (!label || !text) return;
    addUserTemplate(label, text);
    setTemplates([...BUILTIN_TEMPLATES, ...loadUserTemplates()]);
    setSavingTpl(false);
    setTplLabel("");
  }, [tplLabel, body]);

  const handleDeleteTemplate = useCallback((id: string) => {
    removeUserTemplate(id);
    setTemplates([...BUILTIN_TEMPLATES, ...loadUserTemplates()]);
  }, []);

  const submit = useCallback(async () => {
    if (!body.trim()) {
      toast.warning("nothing to create", "fill in the body");
      return;
    }
    try {
      const trimmedBody = body.trim();
      const created = await create.mutateAsync({
        title: deriveTitle(trimmedBody),
        body: trimmedBody,
        app: app === APP_AUTO ? null : app,
      });
      toast.success("task created", created.id);
      onClose();
      onCreated?.(created.id);
    } catch (err) {
      toast.error("create failed", (err as Error).message);
    }
  }, [body, app, create, toast, onClose, onCreated]);

  return (
    <DialogContent className="max-w-xl">
      <DialogHeader>
        <DialogTitle>Describe the task</DialogTitle>
        <DialogDescription>
          The coordinator reads this as the brief. Keep the first line short
          — the bridge promotes it to the title automatically.
        </DialogDescription>
      </DialogHeader>

      <form
        id="new-task-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="grid gap-3"
      >
        {/* Templates row */}
        <div className="flex flex-wrap items-center gap-1">
          <span className="mr-1 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
            Templates
          </span>
          {builtinTemplates.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => applyTemplate(t)}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-secondary px-2 py-0.5 text-[10.5px] hover:bg-accent"
              title={`Insert "${t.label}" template`}
            >
              <Bookmark size={10} className="text-info" />
              {t.label}
            </button>
          ))}
          {userTemplates.map((t) => (
            <span
              key={t.id}
              className="inline-flex items-center gap-0.5 rounded-full border border-border bg-secondary px-2 py-0.5 text-[10.5px] hover:bg-accent"
            >
              <button
                type="button"
                onClick={() => applyTemplate(t)}
                className="inline-flex items-center gap-1"
                title={`Insert "${t.label}" template`}
              >
                <Bookmark size={10} className="text-warning" />
                {t.label}
              </button>
              <button
                type="button"
                onClick={() => handleDeleteTemplate(t.id)}
                className="ml-0.5 text-fg-dim hover:text-destructive"
                aria-label={`Remove template ${t.label}`}
                title="Remove template"
              >
                <X size={10} />
              </button>
            </span>
          ))}
          <button
            type="button"
            onClick={() => setSavingTpl((v) => !v)}
            disabled={!body.trim()}
            className="ml-auto inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-[10.5px] text-muted-foreground hover:border-primary hover:text-foreground disabled:opacity-40"
            title={
              body.trim()
                ? "Save current body as a template"
                : "Type something first"
            }
          >
            <BookmarkPlus size={10} />
            Save as template
          </button>
        </div>

        {savingTpl && (
          <div className="flex items-center gap-2">
            <Input
              value={tplLabel}
              onChange={(e) => setTplLabel(e.target.value)}
              placeholder="Template name"
              className="h-8 flex-1 text-xs"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleSaveTemplate();
                }
                if (e.key === "Escape") {
                  setSavingTpl(false);
                  setTplLabel("");
                }
              }}
              autoFocus
            />
            <Button
              type="button"
              size="xs"
              onClick={handleSaveTemplate}
              disabled={!tplLabel.trim()}
            >
              Save
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => {
                setSavingTpl(false);
                setTplLabel("");
              }}
            >
              Cancel
            </Button>
          </div>
        )}

        {/* Target app picker — shown above the body so the operator
            decides the dispatch target before drafting the brief. */}
        <div className="grid gap-1.5">
          <Label htmlFor="new-task-app">Target app</Label>
          <Select value={app} onValueChange={setApp}>
            <SelectTrigger id="new-task-app" className="h-8">
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
                        <span className="inline-flex items-center gap-1 font-mono text-[10px] text-muted-foreground">
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
            Pick a specific app to constrain dispatch — leave blank to let the
            coordinator decide based on the task body.
          </p>
        </div>

        <Textarea
          ref={bodyRef}
          id="new-task-body"
          autoFocus
          required
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void submit();
            }
          }}
          rows={8}
          placeholder="What needs to happen? First line becomes the task title; rest is context, acceptance criteria, contract links…"
          className="font-mono min-h-[180px]"
        />
      </form>

      <DialogFooter className="gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="submit"
          form="new-task-form"
          disabled={create.isPending || !body.trim()}
        >
          {create.isPending ? "Creating…" : "Create"}
          <kbd className="ml-1 font-mono text-[9px] opacity-60">⌘↵</kbd>
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

