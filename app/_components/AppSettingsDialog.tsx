"use client";

import { useState } from "react";
import { Settings } from "lucide-react";
import type { App, AppGitSettings, GitBranchMode } from "@/lib/client/types";
import { api } from "@/lib/client/api";
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
import { useToast } from "./Toasts";

interface AppSettingsDialogProps {
  /** App to edit. When null the dialog is closed. */
  app: App | null;
  onClose: () => void;
  /** Called with the updated App after a successful save. */
  onSaved: (app: App) => void;
}

const MODE_OPTIONS: Array<{
  value: GitBranchMode;
  label: string;
  hint: string;
}> = [
  {
    value: "current",
    label: "Use the currently-checked-out branch",
    hint: "Default. Claude works on whatever branch HEAD points at when the agent starts.",
  },
  {
    value: "fixed",
    label: "Always work on a fixed branch",
    hint: "Bridge runs `git checkout <branch>` (or creates it from the current branch) before each task.",
  },
  {
    value: "auto-create",
    label: "Auto-create a new branch per task",
    hint: "Bridge creates `claude/<task-id>` from the current branch — keeps each task isolated.",
  },
];

// Same shape as the bridge.json APP_NAME_RE — kept in sync so the UI
// rejects bad names before the round-trip.
const APP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Per-app editor: name + description + git workflow. Persisted to
 * `bridge.json` via PATCH /api/apps/[name]. The dialog is controlled by
 * the parent — pass `app=null` to close.
 *
 * NOTE: the parent should pass `key={app?.name ?? "closed"}` so React
 * remounts this component when the target app changes — that's how we
 * keep the local draft in sync with the prop without a useEffect.
 */
export function AppSettingsDialog({ app, onClose, onSaved }: AppSettingsDialogProps) {
  const [name, setName] = useState<string>(app?.name ?? "");
  const [description, setDescription] = useState<string>(app?.description ?? "");
  const [git, setGit] = useState<AppGitSettings | null>(app?.git ? { ...app.git } : null);
  const [submitting, setSubmitting] = useState(false);
  const toast = useToast();

  if (!app || !git) return null;

  const onModeChange = (mode: GitBranchMode) => {
    setGit((g) => (g ? { ...g, branchMode: mode } : g));
  };

  const trimmedName = name.trim();
  const trimmedDescription = description.trim();
  const nameDirty = trimmedName !== app.name;
  const descriptionDirty = trimmedDescription !== app.description;
  const gitDirty =
    git.branchMode !== app.git.branchMode ||
    git.fixedBranch.trim() !== app.git.fixedBranch ||
    git.autoCommit !== app.git.autoCommit ||
    git.autoPush !== app.git.autoPush;
  const dirty = nameDirty || descriptionDirty || gitDirty;

  const submit = async () => {
    if (!APP_NAME_RE.test(trimmedName)) {
      toast("error", "Invalid app name (letters, digits, dot, dash, underscore; must start alphanumeric).");
      return;
    }
    if (git.branchMode === "fixed" && !git.fixedBranch.trim()) {
      toast("error", "Fixed-branch mode needs a branch name.");
      return;
    }
    if (!dirty) {
      onClose();
      return;
    }
    setSubmitting(true);
    try {
      const patch: Parameters<typeof api.updateApp>[1] = {};
      if (nameDirty) patch.name = trimmedName;
      if (descriptionDirty) patch.description = trimmedDescription;
      if (gitDirty) patch.git = git;
      const updated = await api.updateApp(app.name, patch);
      const migrated = updated.migratedTasks ?? 0;
      const renameHint = nameDirty
        ? migrated > 0
          ? ` (${migrated} task${migrated === 1 ? "" : "s"} re-tagged)`
          : " (no tasks pointed at the old name)"
        : "";
      toast("success", `Saved ${updated.name}${renameHint}`);
      onSaved(updated);
      onClose();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings size={16} />
            <span>Edit app — <span className="font-mono">{app.name}</span></span>
          </DialogTitle>
          <DialogDescription>
            Update the app&apos;s identity and how the bridge prepares git
            for tasks targeting it.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => { e.preventDefault(); submit(); }}
          className="grid gap-4"
        >
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="app-name">Name</Label>
              <Input
                id="app-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={app.name}
                className="font-mono h-8"
                autoComplete="off"
              />
              <p className="text-[11px] text-muted-foreground">
                Used by the coordinator to dispatch tasks to this folder.
                Renaming re-tags every task currently pointing at the old name.
              </p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="app-description">Description</Label>
              <Textarea
                id="app-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                placeholder="One or two lines about what this app does — fed to the dispatch heuristic."
                className="text-xs"
              />
            </div>
          </div>

          <fieldset className="grid gap-2 border-t border-border pt-3">
            <legend className="text-xs font-medium text-foreground mb-1">
              Branch strategy
            </legend>
            {MODE_OPTIONS.map((opt) => {
              const checked = git.branchMode === opt.value;
              return (
                <label
                  key={opt.value}
                  className={`flex gap-2 rounded-md border p-2 cursor-pointer transition-colors ${
                    checked
                      ? "border-primary/50 bg-primary/5"
                      : "border-border hover:bg-accent/40"
                  }`}
                >
                  <input
                    type="radio"
                    name="branchMode"
                    value={opt.value}
                    checked={checked}
                    onChange={() => onModeChange(opt.value)}
                    className="mt-0.5 accent-primary"
                  />
                  <span className="flex-1 min-w-0">
                    <span className="block text-xs font-medium">{opt.label}</span>
                    <span className="block text-[11px] text-muted-foreground">{opt.hint}</span>
                  </span>
                </label>
              );
            })}
          </fieldset>

          {git.branchMode === "fixed" && (
            <div className="grid gap-1.5">
              <Label htmlFor="fixed-branch">Branch name</Label>
              <Input
                id="fixed-branch"
                value={git.fixedBranch}
                onChange={(e) =>
                  setGit((g) => (g ? { ...g, fixedBranch: e.target.value } : g))
                }
                placeholder="develop"
                className="font-mono h-8"
                autoFocus
              />
              <p className="text-[11px] text-muted-foreground">
                Bridge will check out this branch (creating it from the
                current HEAD if missing) before each task.
              </p>
            </div>
          )}

          <div className="grid gap-2 border-t border-border pt-3">
            <ToggleRow
              label="Auto-commit when the task finishes"
              hint="Runs `git add -A && git commit` with the task title as the message after a successful run."
              checked={git.autoCommit}
              onChange={(v) => setGit((g) => (g ? { ...g, autoCommit: v, autoPush: v ? g.autoPush : false } : g))}
            />
            <ToggleRow
              label="Auto-push after auto-commit"
              hint="Runs `git push` to the tracked upstream. Implies auto-commit."
              checked={git.autoPush}
              disabled={!git.autoCommit}
              onChange={(v) => setGit((g) => (g ? { ...g, autoPush: v, autoCommit: v || g.autoCommit } : g))}
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || !dirty}>
              {submitting ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label
      className={`flex items-start gap-2 ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 accent-primary"
      />
      <span className="flex-1 min-w-0">
        <span className="block text-xs font-medium">{label}</span>
        <span className="block text-[11px] text-muted-foreground">{hint}</span>
      </span>
    </label>
  );
}
