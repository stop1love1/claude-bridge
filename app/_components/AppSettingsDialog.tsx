"use client";

import { useState } from "react";
import { Settings } from "lucide-react";
import type {
  App,
  AppGitSettings,
  AppRetry,
  GitBranchMode,
  GitIntegrationMode,
} from "@/lib/client/types";
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

const INTEGRATION_OPTIONS: Array<{
  value: GitIntegrationMode;
  label: string;
  hint: string;
}> = [
  {
    value: "none",
    label: "None — leave the work branch alone",
    hint: "Default. Operator merges or opens a PR by hand.",
  },
  {
    value: "auto-merge",
    label: "Auto-merge into a target branch (local git)",
    hint: "Bridge runs `git merge --no-ff` after the work branch commits. Conflict aborts cleanly; work branch preserved. No remote needed.",
  },
  {
    value: "pull-request",
    label: "Open a PR/MR via gh / glab (devops agent)",
    hint: "Bridge spawns a devops agent that uses the matching CLI. Requires git remote + `gh` or `glab` installed. Implies auto-push.",
  },
];

// Mirrors `MAX_RETRY_PER_GATE` in lib/retryLadder.ts — kept inline here so
// the slider UI doesn't have to import server code.
const MAX_RETRY_PER_GATE = 5;

const RETRY_GATES: Array<{
  key: keyof AppRetry;
  label: string;
  hint: string;
}> = [
  {
    key: "crash",
    label: "Crash retry",
    hint: "Child agent exited non-zero. Re-runs with the failure transcript injected.",
  },
  {
    key: "verify",
    label: "Verify-chain retry",
    hint: "format/lint/typecheck/test/build failed. Re-runs with the failing step's output.",
  },
  {
    key: "claim",
    label: "Claim-vs-diff retry",
    hint: "Report's `## Changed files` didn't match the actual diff. Re-runs to fix the discrepancy.",
  },
  {
    key: "preflight",
    label: "Preflight retry",
    hint: "Agent edited code without enough Read calls first. Re-runs with a process directive.",
  },
  {
    key: "style",
    label: "Style-critic retry",
    hint: "LLM critic flagged the diff as alien to the codebase. Re-runs with critic findings.",
  },
  {
    key: "semantic",
    label: "Semantic-verifier retry",
    hint: "LLM verifier judged the diff doesn't accomplish the task. Re-runs with concerns.",
  },
];

/**
 * Strategy ladder for attempt N (purely informational — the prompt
 * shape is decided server-side by `retryLadder.strategyForAttempt`).
 */
const STRATEGY_AT_ATTEMPT: Record<number, string> = {
  1: "same-context (full prompt + failure)",
  2: "fresh-focus (drop chatter, focus narrowly)",
  3: "fixer-only (one-line directive)",
  4: "fixer-only",
  5: "fixer-only",
};

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
  const [retry, setRetry] = useState<AppRetry>(app?.retry ?? {});
  const [submitting, setSubmitting] = useState(false);
  const toast = useToast();

  if (!app || !git) return null;

  const onModeChange = (mode: GitBranchMode) => {
    setGit((g) => (g ? { ...g, branchMode: mode } : g));
  };

  // Switching integration mode promotes the matching git settings so the
  // mode is internally consistent the moment it lands. Mirrors the
  // server-side normalize rules in lib/apps.ts.
  const onIntegrationModeChange = (mode: GitIntegrationMode) => {
    setGit((g) => {
      if (!g) return g;
      if (mode === "none") {
        return { ...g, integrationMode: "none", mergeTargetBranch: "" };
      }
      if (mode === "pull-request") {
        return { ...g, integrationMode: "pull-request", autoCommit: true, autoPush: true };
      }
      return { ...g, integrationMode: "auto-merge", autoCommit: true };
    });
  };

  const trimmedName = name.trim();
  const trimmedDescription = description.trim();
  const nameDirty = trimmedName !== app.name;
  const descriptionDirty = trimmedDescription !== app.description;
  const gitDirty =
    git.branchMode !== app.git.branchMode ||
    git.fixedBranch.trim() !== app.git.fixedBranch ||
    git.autoCommit !== app.git.autoCommit ||
    git.autoPush !== app.git.autoPush ||
    git.mergeTargetBranch.trim() !== app.git.mergeTargetBranch ||
    git.integrationMode !== app.git.integrationMode;
  const retryDirty = (() => {
    const original = app.retry ?? {};
    const keys = new Set([
      ...Object.keys(original),
      ...Object.keys(retry),
    ]) as Set<keyof AppRetry>;
    for (const k of keys) {
      if ((original[k] ?? null) !== (retry[k] ?? null)) return true;
    }
    return false;
  })();
  const dirty = nameDirty || descriptionDirty || gitDirty || retryDirty;

  const submit = async () => {
    if (!APP_NAME_RE.test(trimmedName)) {
      toast("error", "Invalid app name (letters, digits, dot, dash, underscore; must start alphanumeric).");
      return;
    }
    if (git.branchMode === "fixed" && !git.fixedBranch.trim()) {
      toast("error", "Fixed-branch mode needs a branch name.");
      return;
    }
    const targetBranch = git.mergeTargetBranch.trim();
    if (targetBranch && !/^[A-Za-z0-9._/-]{1,200}$/.test(targetBranch)) {
      toast("error", "Merge target branch contains invalid characters.");
      return;
    }
    if (git.integrationMode !== "none" && !targetBranch) {
      toast("error", "Integration needs a target branch (or set mode to None).");
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
      if (retryDirty) {
        // Diff against the original so we send `null` for cleared keys
        // and only send numeric values for set keys. The server treats
        // `null` as "revert to default" and missing keys as "no change".
        const original = app.retry ?? {};
        const next: Partial<Record<keyof AppRetry, number | null>> = {};
        const keys = new Set([
          ...Object.keys(original),
          ...Object.keys(retry),
        ]) as Set<keyof AppRetry>;
        for (const k of keys) {
          const before = original[k] ?? null;
          const after = retry[k] ?? null;
          if (before === after) continue;
          next[k] = after;
        }
        patch.retry = next;
      }
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
              onChange={(v) => setGit((g) => (g ? {
                ...g,
                autoCommit: v,
                // Disabling auto-commit cascades: no push, no integration.
                autoPush: v ? g.autoPush : false,
                integrationMode: v ? g.integrationMode : "none",
                mergeTargetBranch: v ? g.mergeTargetBranch : "",
              } : g))}
            />
            <ToggleRow
              label="Auto-push after auto-commit"
              hint="Runs `git push` to the tracked upstream. Implies auto-commit."
              checked={git.autoPush}
              disabled={!git.autoCommit || git.integrationMode === "pull-request"}
              onChange={(v) => setGit((g) => (g ? { ...g, autoPush: v, autoCommit: v || g.autoCommit } : g))}
            />
          </div>

          <fieldset className="grid gap-2 border-t border-border pt-3">
            <legend className="text-xs font-medium text-foreground mb-1">
              Post-success integration
            </legend>
            {INTEGRATION_OPTIONS.map((opt) => {
              const checked = git.integrationMode === opt.value;
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
                    name="integrationMode"
                    value={opt.value}
                    checked={checked}
                    onChange={() => onIntegrationModeChange(opt.value)}
                    className="mt-0.5 accent-primary"
                  />
                  <span className="flex-1 min-w-0">
                    <span className="block text-xs font-medium">{opt.label}</span>
                    <span className="block text-[11px] text-muted-foreground">{opt.hint}</span>
                  </span>
                </label>
              );
            })}
            {git.integrationMode !== "none" && (
              <div className="grid gap-1.5 mt-1">
                <Label htmlFor="merge-target" className="text-xs font-medium">
                  Target branch
                </Label>
                <Input
                  id="merge-target"
                  value={git.mergeTargetBranch}
                  onChange={(e) =>
                    setGit((g) => (g ? { ...g, mergeTargetBranch: e.target.value } : g))
                  }
                  placeholder="main"
                  className="font-mono h-8"
                  autoFocus
                />
                <p className="text-[11px] text-muted-foreground">
                  {git.integrationMode === "auto-merge"
                    ? "Bridge runs git checkout <target> + git merge --no-ff. Conflict aborts cleanly; work branch preserved."
                    : "Bridge spawns the devops agent which uses gh / glab to open a PR/MR. Requires git remote + the matching CLI installed; otherwise skipped with a warning."}
                </p>
              </div>
            )}
          </fieldset>

          <fieldset className="grid gap-2 border-t border-border pt-3">
            <legend className="text-xs font-medium text-foreground mb-1">
              Retry budgets
            </legend>
            <p className="text-[11px] text-muted-foreground -mt-1 mb-1">
              Per-gate attempt cap. Default 1 = single retry. Higher
              budgets unlock the strategy ladder: attempt 2 = focused
              re-prompt, attempt 3+ = fixer-only directive.
            </p>
            {RETRY_GATES.map((gate) => {
              const value = retry[gate.key] ?? 1; // unset → default 1
              return (
                <div key={gate.key} className="grid gap-1 rounded-md border border-border p-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium">{gate.label}</span>
                    <select
                      value={String(value)}
                      onChange={(e) => {
                        const n = parseInt(e.target.value, 10);
                        setRetry((r) => ({ ...r, [gate.key]: n }));
                      }}
                      className="h-7 rounded border border-input bg-background px-2 text-xs font-mono"
                    >
                      {Array.from({ length: MAX_RETRY_PER_GATE + 1 }, (_, i) => (
                        <option key={i} value={i}>
                          {i === 0 ? "0 (off)" : `${i} attempt${i === 1 ? "" : "s"}`}
                        </option>
                      ))}
                    </select>
                  </div>
                  <span className="text-[11px] text-muted-foreground">{gate.hint}</span>
                  {value >= 2 && (
                    <span className="text-[10px] text-muted-foreground/80 font-mono">
                      strategy: 1→{STRATEGY_AT_ATTEMPT[1]}; 2→{STRATEGY_AT_ATTEMPT[2]}
                      {value >= 3 ? `; ≥3→${STRATEGY_AT_ATTEMPT[3]}` : ""}
                    </span>
                  )}
                </div>
              );
            })}
          </fieldset>

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
