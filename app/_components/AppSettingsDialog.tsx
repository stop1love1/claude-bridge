"use client";

import { useEffect, useState } from "react";
import { Settings } from "lucide-react";
import type {
  App,
  AppGitSettings,
  AppRetry,
  GitBranchMode,
  GitIntegrationMode,
  RoleSpec,
} from "@/libs/client/types";
import { api } from "@/libs/client/api";
import { appDetailRouteSegment } from "@/libs/client/appRoutes";
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
import { useModelChoices } from "./ModelPicker";
import { useToast } from "./Toasts";

/** Matches `ROLE_MODELS_WILDCARD` on the server: "every role in this app". */
const ROLE_MODELS_WILDCARD = "*";

interface AppSettingsDialogProps {
  app: App | null;
  onClose: () => void;
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

const STRATEGY_AT_ATTEMPT: Record<number, string> = {
  1: "same-context (full prompt + failure)",
  2: "fresh-focus (drop chatter, focus narrowly)",
  3: "fixer-only (one-line directive)",
  4: "fixer-only",
  5: "fixer-only",
};

export function AppSettingsDialog({ app, onClose, onSaved }: AppSettingsDialogProps) {
  const [name, setName] = useState<string>(app?.name ?? "");
  const [description, setDescription] = useState<string>(app?.description ?? "");
  const [git, setGit] = useState<AppGitSettings | null>(app?.git ? { ...app.git } : null);
  const [retry, setRetry] = useState<AppRetry>(app?.retry ?? {});
  const [roleModels, setRoleModels] = useState<Record<string, string>>(
    () => ({ ...(app?.roleModels ?? {}) }),
  );
  const [roles, setRoles] = useState<RoleSpec[] | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const toast = useToast();

  const open = !!app;
  const { models, failed: modelsFailed } = useModelChoices(open);

  useEffect(() => {
    if (!open || roles !== null) return;
    let cancelled = false;
    void api
      .roles()
      .then((r) => {
        if (!cancelled) setRoles(r.roles);
      })
      .catch(() => {
        if (!cancelled) setRoles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, roles]);

  if (!app || !git) return null;

  const onModeChange = (mode: GitBranchMode) => {
    setGit((g) => (g ? { ...g, branchMode: mode } : g));
  };

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
  const originalRoleModels = app.roleModels ?? {};
  const roleModelKeys = Array.from(
    new Set([...Object.keys(originalRoleModels), ...Object.keys(roleModels)]),
  );
  const roleModelsDirty = roleModelKeys.some(
    (k) => (originalRoleModels[k] ?? null) !== (roleModels[k] ?? null),
  );
  const dirty = nameDirty || descriptionDirty || gitDirty || retryDirty || roleModelsDirty;

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
      if (roleModelsDirty) {
        // Only the keys that actually changed travel; a key whose pin was
        // cleared is sent as null so the server deletes it.
        const next: Record<string, string | null> = {};
        for (const k of roleModelKeys) {
          const before = originalRoleModels[k] ?? null;
          const after = roleModels[k] ?? null;
          if (before === after) continue;
          next[k] = after;
        }
        patch.roleModels = next;
      }
      const updated = await api.updateApp(appDetailRouteSegment(app), patch);
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
                {git.integrationMode === "pull-request" && app && (
                  <DevopsConnectionCheck
                    appSegment={appDetailRouteSegment(app)}
                  />
                )}
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
              const value = retry[gate.key] ?? 1;
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

          <fieldset className="grid gap-2 border-t border-border pt-3">
            <legend className="text-xs font-medium text-foreground mb-1">
              Model pinning
            </legend>
            <p className="text-[11px] text-muted-foreground -mt-1 mb-1">
              Pins the <span className="font-mono">--model</span> the bridge
              spawns each role with in this app. A role&apos;s own pin beats
              the wildcard, and both beat a task-level pin. Leave everything on
              Default and dispatch behaves exactly as it does with no pin at
              all. Labelled roles inherit their base — a{" "}
              <span className="font-mono">coder-api</span> child uses the{" "}
              <span className="font-mono">coder</span> pin.
            </p>
            {modelsFailed && (
              <p className="text-[11px] text-amber-700">
                Could not read the model list from the Claude CLI — existing
                pins are shown but cannot be changed here.
              </p>
            )}
            <RoleModelRow
              label="All roles"
              hint="Wildcard fallback for any role without a pin of its own."
              value={roleModels[ROLE_MODELS_WILDCARD]}
              models={models}
              onChange={(v) =>
                setRoleModels((m) => {
                  const next = { ...m };
                  if (v) next[ROLE_MODELS_WILDCARD] = v;
                  else delete next[ROLE_MODELS_WILDCARD];
                  return next;
                })
              }
            />
            {(roles ?? []).map((r) => (
              <RoleModelRow
                key={r.name}
                label={r.name}
                hint={r.description}
                value={roleModels[r.name]}
                models={models}
                onChange={(v) =>
                  setRoleModels((m) => {
                    const next = { ...m };
                    if (v) next[r.name] = v;
                    else delete next[r.name];
                    return next;
                  })
                }
              />
            ))}
            {roles === null && (
              <p className="text-[11px] text-muted-foreground">Reading the role registry…</p>
            )}
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

function RoleModelRow({
  label,
  hint,
  value,
  models,
  onChange,
}: {
  label: string;
  hint: string;
  value: string | undefined;
  models: { value: string; label: string }[] | null;
  onChange: (next: string | undefined) => void;
}) {
  // A pin already saved for a model the CLI no longer advertises still has to
  // be selectable, or opening this dialog would silently drop it on save.
  const options = models ?? [];
  const missing = value && !options.some((m) => m.value === value) ? value : null;
  return (
    <div className="grid gap-1 rounded-md border border-border p-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium font-mono">{label}</span>
        <select
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value || undefined)}
          className="h-7 max-w-[60%] rounded border border-input bg-background px-2 text-xs font-mono"
        >
          <option value="">Default (no pin)</option>
          {missing && <option value={missing}>{missing} (not in CLI list)</option>}
          {options.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </div>
      <span className="text-[11px] text-muted-foreground">{hint}</span>
    </div>
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

interface DevopsCheckResult {
  ok: boolean;
  stage: string;
  reason: string;
  cli: string | null;
  host: string | null;
  remote: string | null;
}

function DevopsConnectionCheck({ appSegment }: { appSegment: string }) {
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "checking" }
    | { kind: "done"; result: DevopsCheckResult }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  const run = async () => {
    setState({ kind: "checking" });
    try {
      const r = await fetch(`/api/apps/${appSegment}/devops-check`, {
        cache: "no-store",
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        setState({
          kind: "error",
          message: body.error ?? `HTTP ${r.status}`,
        });
        return;
      }
      const result = (await r.json()) as DevopsCheckResult;
      setState({ kind: "done", result });
    } catch (e) {
      setState({ kind: "error", message: (e as Error).message });
    }
  };

  return (
    <div className="mt-2 grid gap-1.5 rounded-md border border-border bg-muted/30 p-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium">Connection check</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={run}
          disabled={state.kind === "checking"}
          className="h-7 text-[11px]"
        >
          {state.kind === "checking" ? "Checking…" : "Test connection"}
        </Button>
      </div>
      {state.kind === "idle" && (
        <p className="text-[11px] text-muted-foreground">
          Verifies `gh` / `glab` is installed and authenticated for this
          app&apos;s `origin` remote. Run before saving to avoid runtime
          surprises.
        </p>
      )}
      {state.kind === "done" && (
        <div
          className={`text-[11px] font-mono ${
            state.result.ok ? "text-emerald-700" : "text-amber-700"
          }`}
        >
          <div>{state.result.ok ? "✓" : "⚠"} {state.result.reason}</div>
          {state.result.cli && (
            <div className="mt-0.5 text-muted-foreground">
              cli=<span className="font-semibold">{state.result.cli}</span>{" "}
              host=<span className="font-semibold">{state.result.host}</span>
              {state.result.remote && (
                <>
                  {" "}
                  remote=
                  <span className="font-semibold break-all">{state.result.remote}</span>
                </>
              )}
            </div>
          )}
        </div>
      )}
      {state.kind === "error" && (
        <div className="text-[11px] text-destructive font-mono">
          ✗ Error: {state.message}
        </div>
      )}
    </div>
  );
}
