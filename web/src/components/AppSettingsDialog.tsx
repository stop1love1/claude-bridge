import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/components/Toasts";
import { api } from "@/api/client";
import { qk } from "@/api/queries";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  App,
  AppGitSettings,
  AppQuality,
  AppRetry,
  AppVerify,
  GitBranchMode,
  GitIntegrationMode,
  GitWorktreeMode,
  AppExtras,
} from "@/api/types";

interface Props {
  app: App | null;
  onClose: () => void;
}

// Mirrors the bridge.json APP_NAME_RE so the UI rejects bad names
// before the round-trip. Same regex Go uses server-side.
const APP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const BRANCH_MODES: { value: GitBranchMode; label: string }[] = [
  { value: "current", label: "current — use whatever HEAD is on" },
  { value: "fixed", label: "fixed — checkout a named branch" },
  { value: "auto-create", label: "auto-create — claude/<task-id>" },
];

const WORKTREE_MODES: { value: GitWorktreeMode; label: string }[] = [
  { value: "disabled", label: "disabled — operate in the main tree" },
  { value: "enabled", label: "enabled — isolated worktree per run" },
];

const INTEGRATION_MODES: {
  value: GitIntegrationMode;
  label: string;
  hint: string;
}[] = [
  {
    value: "none",
    label: "none — leave the work branch alone",
    hint: "default. operator merges or opens a PR by hand.",
  },
  {
    value: "auto-merge",
    label: "auto-merge — git merge into target",
    hint: "bridge runs git merge --no-ff after a successful task. conflict aborts cleanly.",
  },
  {
    value: "pull-request",
    label: "pull-request — open a PR/MR",
    hint: "bridge spawns a devops agent that uses gh / glab. requires remote + matching CLI.",
  },
];

const RETRY_GATES: Array<{ key: keyof AppRetry; label: string; hint: string }> = [
  { key: "crash", label: "crash", hint: "child agent exited non-zero" },
  { key: "verify", label: "verify", hint: "format/lint/typecheck/test/build" },
  { key: "claim", label: "claim", hint: "claim-vs-diff mismatch" },
  { key: "preflight", label: "preflight", hint: "preflight gate failure" },
  { key: "style", label: "style", hint: "style-critic gate" },
  { key: "semantic", label: "semantic", hint: "semantic verifier" },
];

const MAX_RETRY_PER_GATE = 5;

/**
 * Strategy ladder for attempt N (purely informational — the prompt
 * shape is decided server-side by `retryLadder.strategyForAttempt`).
 */
const STRATEGY_AT_ATTEMPT: Record<number, string> = {
  1: "same-context (full prompt + failure)",
  2: "fresh-focus (drop chatter, narrow scope)",
  3: "fixer-only (one-line directive)",
  4: "fixer-only",
  5: "fixer-only",
};

/**
 * Tabbed editor — Identity / Git / Retry / Verify / Quality / Extras.
 * Pass `app=null` to close. Use `key={app?.name ?? "closed"}` on the
 * parent so the local draft resets when the target app changes.
 */
export function AppSettingsDialog({ app, onClose }: Props) {
  const toast = useToast();
  const qc = useQueryClient();

  // ---- draft state ------------------------------------------------------
  const [name, setName] = useState<string>(app?.name ?? "");
  const [description, setDescription] = useState<string>(app?.description ?? "");
  const [git, setGit] = useState<AppGitSettings>(() =>
    app?.git
      ? {
          branchMode: app.git.branchMode ?? "current",
          fixedBranch: app.git.fixedBranch ?? "",
          autoCommit: app.git.autoCommit ?? false,
          autoPush: app.git.autoPush ?? false,
          worktreeMode: app.git.worktreeMode ?? "disabled",
          mergeTargetBranch: app.git.mergeTargetBranch ?? "",
          integrationMode: app.git.integrationMode ?? "none",
        }
      : {
          branchMode: "current",
          fixedBranch: "",
          autoCommit: false,
          autoPush: false,
          worktreeMode: "disabled",
          mergeTargetBranch: "",
          integrationMode: "none",
        },
  );
  const [retry, setRetry] = useState<AppRetry>(() => app?.retry ?? {});
  const [verify, setVerify] = useState<AppVerify>(() => app?.verify ?? {});
  const [quality, setQuality] = useState<AppQuality>(() => app?.quality ?? {});
  const [pinnedFilesText, setPinnedFilesText] = useState<string>(() =>
    (app?.pinnedFiles ?? []).join("\n"),
  );
  const [symbolDirsText, setSymbolDirsText] = useState<string>(() =>
    (app?.symbolDirs ?? []).join("\n"),
  );
  const [extrasText, setExtrasText] = useState<string>(() =>
    app?.extras ? JSON.stringify(app.extras, null, 2) : "{}",
  );
  const [extrasError, setExtrasError] = useState<string | null>(null);

  // The Go bridge doesn't expose PATCH /api/apps/{name}; the only
  // documented mutations are POST /api/apps (add) and DELETE. We
  // round-trip the full record via remove + add to simulate an update.
  const update = useMutation({
    mutationFn: async (patch: Partial<App>): Promise<App> => {
      if (!app) throw new Error("no app loaded");
      const merged: App = { ...app, ...patch };
      await api.apps.remove(app.name);
      await api.apps.add({
        name: merged.name,
        path: merged.path,
        description: merged.description,
      });
      return merged;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.apps });
    },
  });

  const extrasParsed = useMemo<AppExtras | null>(() => {
    try {
      const parsed = JSON.parse(extrasText) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as AppExtras;
      }
      return null;
    } catch {
      return null;
    }
  }, [extrasText]);

  const trimmedName = name.trim();
  const nameValid = APP_NAME_RE.test(trimmedName);

  if (!app) return null;

  const splitLines = (txt: string): string[] =>
    txt
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

  // Switching integration mode promotes the matching git settings so
  // the mode is internally consistent the moment it lands.
  const onIntegrationModeChange = (mode: GitIntegrationMode) => {
    setGit((g) => {
      if (mode === "none") {
        return { ...g, integrationMode: "none", mergeTargetBranch: "" };
      }
      if (mode === "pull-request") {
        return {
          ...g,
          integrationMode: "pull-request",
          autoCommit: true,
          autoPush: true,
        };
      }
      return { ...g, integrationMode: "auto-merge", autoCommit: true };
    });
  };

  const submit = async () => {
    if (!nameValid) {
      toast.error(
        "invalid name",
        "letters, digits, dot, dash, underscore; must start alphanumeric",
      );
      return;
    }
    if (git.branchMode === "fixed" && !git.fixedBranch.trim()) {
      toast.error("validation", "fixed-branch mode needs a branch name");
      return;
    }
    const targetBranch = (git.mergeTargetBranch ?? "").trim();
    if (
      (git.integrationMode ?? "none") !== "none" &&
      !targetBranch
    ) {
      toast.error(
        "validation",
        "integration needs a target branch (or set mode to none)",
      );
      return;
    }
    if (extrasText.trim().length > 0) {
      try {
        const parsed = JSON.parse(extrasText) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          setExtrasError("extras must be a JSON object");
          return;
        }
      } catch (e) {
        setExtrasError(`invalid JSON: ${(e as Error).message}`);
        return;
      }
    }
    setExtrasError(null);
    try {
      await update.mutateAsync({
        name: trimmedName,
        description: description.trim(),
        git,
        retry,
        verify,
        quality,
        pinnedFiles: splitLines(pinnedFilesText),
        symbolDirs: splitLines(symbolDirsText),
        extras: extrasParsed ?? {},
      });
      toast.success(`saved ${trimmedName}`);
      onClose();
    } catch (e) {
      toast.error("save failed", (e as Error).message);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            edit <span className="font-mono text-foreground">{app.name}</span>
          </DialogTitle>
          <DialogDescription>
            git workflow, retry budgets, verify commands, quality gates, and
            extras for the bridge to honor when running tasks here.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="id" className="w-full">
          <TabsList>
            <TabsTrigger value="id">identity</TabsTrigger>
            <TabsTrigger value="git">git</TabsTrigger>
            <TabsTrigger value="integration">integration</TabsTrigger>
            <TabsTrigger value="retry">retry</TabsTrigger>
            <TabsTrigger value="verify">verify</TabsTrigger>
            <TabsTrigger value="quality">quality</TabsTrigger>
            <TabsTrigger value="extras">extras</TabsTrigger>
          </TabsList>

          {/* ─── Identity ─── */}
          <TabsContent value="id" className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="app-name">name</Label>
              <Input
                id="app-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={app.name}
                spellCheck={false}
                autoComplete="off"
              />
              {!nameValid && (
                <p className="font-mono text-micro text-status-blocked">
                  invalid characters — use letters, digits, dot, dash,
                  underscore; must start alphanumeric
                </p>
              )}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="app-desc">description</Label>
              <Textarea
                id="app-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                placeholder="one or two lines about what this app does — fed to dispatch heuristic"
              />
            </div>
          </TabsContent>

          {/* ─── Git ─── */}
          <TabsContent value="git" className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="branch-mode">branch mode</Label>
              <Select
                value={git.branchMode}
                onValueChange={(v) =>
                  setGit({ ...git, branchMode: v as GitBranchMode })
                }
              >
                <SelectTrigger id="branch-mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BRANCH_MODES.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {git.branchMode === "fixed" && (
              <div className="grid gap-1.5">
                <Label htmlFor="fixed-branch">fixed branch</Label>
                <Input
                  id="fixed-branch"
                  value={git.fixedBranch}
                  onChange={(e) =>
                    setGit({ ...git, fixedBranch: e.target.value })
                  }
                  placeholder="develop"
                />
              </div>
            )}

            <div className="grid gap-1.5">
              <Label htmlFor="worktree-mode">worktree mode</Label>
              <Select
                value={git.worktreeMode ?? "disabled"}
                onValueChange={(v) =>
                  setGit({ ...git, worktreeMode: v as GitWorktreeMode })
                }
              >
                <SelectTrigger id="worktree-mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WORKTREE_MODES.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <SwitchRow
              label="auto-commit"
              hint="run `git add -A && git commit` after a successful run"
              checked={git.autoCommit}
              onChange={(v) =>
                setGit({
                  ...git,
                  autoCommit: v,
                  autoPush: v ? git.autoPush : false,
                })
              }
            />
            <SwitchRow
              label="auto-push"
              hint="run `git push` after auto-commit (requires auto-commit)"
              checked={git.autoPush}
              disabled={!git.autoCommit}
              onChange={(v) => setGit({ ...git, autoPush: v })}
            />
          </TabsContent>

          {/* ─── Integration ─── */}
          <TabsContent value="integration" className="grid gap-3">
            <p className="-mt-1 text-[11px] text-muted-foreground">
              what the bridge does after a task lands a successful commit on
              the work branch.
            </p>
            <div className="grid gap-1.5">
              <Label htmlFor="integration-mode">mode</Label>
              <Select
                value={git.integrationMode ?? "none"}
                onValueChange={(v) =>
                  onIntegrationModeChange(v as GitIntegrationMode)
                }
              >
                <SelectTrigger id="integration-mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {INTEGRATION_MODES.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                {INTEGRATION_MODES.find(
                  (m) => m.value === (git.integrationMode ?? "none"),
                )?.hint ?? ""}
              </p>
            </div>

            {(git.integrationMode === "auto-merge" ||
              git.integrationMode === "pull-request") && (
              <div className="grid gap-1.5">
                <Label htmlFor="merge-target">merge target branch</Label>
                <Input
                  id="merge-target"
                  value={git.mergeTargetBranch ?? ""}
                  onChange={(e) =>
                    setGit({ ...git, mergeTargetBranch: e.target.value })
                  }
                  placeholder="main"
                />
                <p className="text-[11px] text-muted-foreground">
                  {git.integrationMode === "auto-merge"
                    ? "bridge runs git checkout <target> + git merge --no-ff. conflict aborts cleanly."
                    : "bridge spawns the devops agent which uses gh / glab to open a PR/MR."}
                </p>
              </div>
            )}
          </TabsContent>

          {/* ─── Retry ─── */}
          <TabsContent value="retry" className="grid gap-2">
            <p className="-mt-1 text-[11px] text-muted-foreground">
              per-gate attempt cap. unset = bridge default (1). higher budgets
              unlock the strategy ladder.
            </p>
            {RETRY_GATES.map((gate) => {
              const value = retry[gate.key] ?? 1;
              return (
                <div
                  key={gate.key}
                  className="flex items-center justify-between gap-3 rounded-sm border border-border p-2"
                >
                  <div className="min-w-0">
                    <div className="font-mono text-micro uppercase tracking-wideish text-foreground">
                      {gate.label}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {gate.hint}
                    </div>
                  </div>
                  <Input
                    type="number"
                    min={0}
                    max={MAX_RETRY_PER_GATE}
                    value={value}
                    onChange={(e) => {
                      let n = parseInt(e.target.value, 10);
                      if (Number.isNaN(n)) n = 0;
                      if (n < 0) n = 0;
                      if (n > MAX_RETRY_PER_GATE) n = MAX_RETRY_PER_GATE;
                      setRetry({ ...retry, [gate.key]: n });
                    }}
                    className="h-7 w-20 text-center font-mono text-xs"
                  />
                </div>
              );
            })}

            <div className="mt-2 rounded-sm border border-border p-2">
              <div className="mb-1 font-mono text-micro uppercase tracking-wideish text-muted-foreground">
                strategy ladder
              </div>
              <table className="w-full font-mono text-[11px]">
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="w-16 font-normal">attempt</th>
                    <th className="font-normal">strategy</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(STRATEGY_AT_ATTEMPT).map(([n, s]) => (
                    <tr key={n} className="text-foreground">
                      <td className="tabular-nums">{n}</td>
                      <td className="text-muted-foreground">{s}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </TabsContent>

          {/* ─── Verify ─── */}
          <TabsContent value="verify" className="grid gap-3">
            <p className="-mt-1 text-[11px] text-muted-foreground">
              shell commands the verify-chain runs after each successful
              child. leave blank to skip a step.
            </p>
            {(["format", "lint", "typecheck", "test", "build"] as const).map(
              (key) => (
                <div key={key} className="grid gap-1.5">
                  <Label htmlFor={`verify-${key}`}>{key}</Label>
                  <Input
                    id={`verify-${key}`}
                    value={verify[key] ?? ""}
                    onChange={(e) =>
                      setVerify({ ...verify, [key]: e.target.value })
                    }
                    placeholder={defaultPlaceholder(key)}
                    spellCheck={false}
                  />
                </div>
              ),
            )}
          </TabsContent>

          {/* ─── Quality ─── */}
          <TabsContent value="quality" className="grid gap-3">
            <p className="-mt-1 text-[11px] text-muted-foreground">
              optional LLM-driven gates that run on a successful diff. each
              one can re-prompt via its own retry budget.
            </p>
            <SwitchRow
              label="style critic"
              hint="LLM critic flags diffs that look alien to the codebase"
              checked={!!quality.critic}
              onChange={(v) => setQuality({ ...quality, critic: v })}
            />
            <SwitchRow
              label="semantic verifier"
              hint="LLM verifier judges whether the diff accomplishes the task"
              checked={!!quality.verifier}
              onChange={(v) => setQuality({ ...quality, verifier: v })}
            />

            <div className="grid gap-1.5">
              <Label htmlFor="pinned-files">pinned files</Label>
              <Textarea
                id="pinned-files"
                value={pinnedFilesText}
                onChange={(e) => setPinnedFilesText(e.target.value)}
                rows={4}
                spellCheck={false}
                placeholder="one path per line — always injected into the agent context"
                className="font-mono"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="symbol-dirs">symbol dirs</Label>
              <Textarea
                id="symbol-dirs"
                value={symbolDirsText}
                onChange={(e) => setSymbolDirsText(e.target.value)}
                rows={3}
                spellCheck={false}
                placeholder="one directory per line — symbol indexer scopes here"
                className="font-mono"
              />
            </div>
          </TabsContent>

          {/* ─── Extras ─── */}
          <TabsContent value="extras" className="grid gap-2">
            <p className="text-[11px] text-muted-foreground">
              freeform JSON object. the bridge round-trips this verbatim;
              consumers like the coordinator prompt may read it.
            </p>
            <Textarea
              value={extrasText}
              onChange={(e) => {
                setExtrasText(e.target.value);
                setExtrasError(null);
              }}
              rows={10}
              spellCheck={false}
              className="font-mono"
            />
            {extrasError && (
              <p className="font-mono text-micro text-status-blocked">
                {extrasError}
              </p>
            )}
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={update.isPending}>
            cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={update.isPending || !nameValid}
          >
            {update.isPending ? "saving…" : "save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function defaultPlaceholder(key: keyof AppVerify): string {
  switch (key) {
    case "format":
      return "pnpm fmt";
    case "lint":
      return "pnpm lint";
    case "typecheck":
      return "pnpm tsc --noEmit";
    case "test":
      return "pnpm test";
    case "build":
      return "pnpm build";
    default:
      return "";
  }
}

function SwitchRow({
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
      className={`flex items-start gap-2 rounded-sm border border-border p-2 ${
        disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 accent-accent"
      />
      <span className="flex-1 min-w-0">
        <span className="block font-mono text-micro uppercase tracking-wideish text-foreground">
          {label}
        </span>
        <span className="block text-[11px] text-muted-foreground">{hint}</span>
      </span>
    </label>
  );
}
