"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GitBranch, Plus, Bookmark, BookmarkPlus, X } from "lucide-react";
import type { App, Repo } from "@/lib/client/types";
import {
  type TaskTemplate,
  allTemplates,
  addUserTemplate,
  removeUserTemplate,
} from "@/lib/client/taskTemplates";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
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

interface DialogProps {
  apps: App[];
  repos?: Repo[];
  onCreate: (t: { body: string; app: string | null }) => Promise<void>;
  openRef?: React.MutableRefObject<(() => void) | null>;
}

/**
 * Outer just owns the `open` flag and the trigger button. The
 * dialog body lives in `NewTaskDialogBody`, which only mounts while
 * `open === true` — that gives us:
 *   - Fresh `useState` initialisers each open (no reset effect).
 *   - `useState(() => allTemplates())` runs only on the client (no
 *     SSR localStorage access, no hydration mismatch, no
 *     `setTemplates` in an effect).
 */
export function NewTaskDialog({
  apps,
  repos = [],
  onCreate,
  openRef,
}: DialogProps) {
  const [open, setOpen] = useState(false);
  const triggerOpen = useCallback(() => setOpen(true), []);

  useEffect(() => {
    if (!openRef) return;
    openRef.current = triggerOpen;
    return () => {
      if (openRef.current === triggerOpen) openRef.current = null;
    };
  }, [openRef, triggerOpen]);

  return (
    <>
      <Button onClick={triggerOpen}>
        <Plus className="h-3.5 w-3.5" /> New task
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        {open && (
          <NewTaskDialogBody
            apps={apps}
            repos={repos}
            onCreate={onCreate}
            onClose={() => setOpen(false)}
          />
        )}
      </Dialog>
    </>
  );
}

function NewTaskDialogBody({
  apps,
  repos,
  onCreate,
  onClose,
}: {
  apps: App[];
  repos: Repo[];
  onCreate: (t: { body: string; app: string | null }) => Promise<void>;
  onClose: () => void;
}) {
  const branchByApp = useMemo(
    () => new Map(repos.map((r) => [r.name, r.branch ?? null])),
    [repos],
  );
  const [body, setBody] = useState("");
  const [app, setApp] = useState<string>(APP_AUTO);
  const [submitting, setSubmitting] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // Lazy initialiser — runs once on mount, which here means the
  // moment the dialog opens. `allTemplates()` reads localStorage
  // directly; safe because this component only mounts on the
  // client.
  const [templates, setTemplates] = useState<TaskTemplate[]>(() => allTemplates());
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

  const applyTemplate = (t: TaskTemplate) => {
    setBody(t.body);
    setTimeout(() => taRef.current?.focus(), 0);
  };
  const handleSaveTemplate = () => {
    const label = tplLabel.trim();
    const text = body.trim();
    if (!label || !text) return;
    addUserTemplate(label, text);
    setTemplates(allTemplates());
    setSavingTpl(false);
    setTplLabel("");
  };
  const handleDeleteTemplate = (id: string) => {
    removeUserTemplate(id);
    setTemplates(allTemplates());
  };

  const submit = async () => {
    const trimmed = body.trim();
    if (!trimmed) return;
    setSubmitting(true);
    try {
      await onCreate({
        body: trimmed,
        app: app === APP_AUTO ? null : app,
      });
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <DialogContent className="max-w-xl">
      <DialogHeader>
        <DialogTitle>Describe the task</DialogTitle>
        <DialogDescription>
          The coordinator reads this as the brief. Keep the first line short
          and specific — it becomes the session title.
        </DialogDescription>
      </DialogHeader>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="grid gap-3"
      >
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[10.5px] uppercase tracking-wider text-muted-foreground font-semibold mr-1">
            Templates
          </span>
          {builtinTemplates.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => applyTemplate(t)}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-border bg-secondary hover:bg-accent text-[10.5px]"
              title={`Insert "${t.label}" template`}
            >
              <Bookmark size={10} className="text-info" />
              {t.label}
            </button>
          ))}
          {userTemplates.map((t) => (
            <span
              key={t.id}
              className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full border border-border bg-secondary hover:bg-accent text-[10.5px]"
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
            className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-dashed border-border text-[10.5px] text-muted-foreground hover:text-foreground hover:border-primary disabled:opacity-40"
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
              className="h-8 text-xs flex-1"
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
            Pick a specific app to constrain dispatch, or leave on Auto so
            the heuristic chooses based on the task body.
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
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!body.trim() || submitting}>
            {submitting ? "Creating…" : "Create"}
            <kbd className="ml-1 text-[9px] font-mono opacity-60">⌘↵</kbd>
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
