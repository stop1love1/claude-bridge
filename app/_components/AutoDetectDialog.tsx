"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  FolderSearch,
  Loader2,
  RotateCcw,
  Sparkles,
} from "lucide-react";
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
import { api } from "@/lib/client/api";
import type { DetectCandidate, DetectEvent } from "@/lib/client/types";
import { useToast } from "./Toasts";
import { cn } from "@/lib/cn";

type Mode = "config" | "scanning" | "review" | "adding";

interface AutoDetectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fires after the bulk-add succeeds so the parent page can refetch. */
  onAdded?: () => void;
}

interface CandidateRow {
  candidate: DetectCandidate;
  selected: boolean;
  /** User-edited registration name. Defaults to `candidate.name`. */
  editedName: string;
}

/**
 * Multi-step modal driving the auto-detect flow:
 *
 *   1. config   — pick scan roots (textarea, one per line) + recursion depth
 *   2. scanning — SSE stream from `/api/apps/auto-detect/stream`, candidates
 *                 stream in live with a running counter
 *   3. review   — checklist of detected repos with editable names; the
 *                 operator picks which to register
 *   4. adding   — bulk POST to `/api/apps/bulk`; toasts the result and
 *                 kicks Claude description scans in the background
 *
 * The operator's scan roots are persisted to `bridge.json.detect.scanRoots`
 * on confirm so the next session doesn't ask again.
 */
export function AutoDetectDialog({ open, onOpenChange, onAdded }: AutoDetectDialogProps) {
  const [mode, setMode] = useState<Mode>("config");
  const [rootsText, setRootsText] = useState("");
  const [savedRoots, setSavedRoots] = useState<string[] | null>(null);
  const [defaultRoot, setDefaultRoot] = useState("");
  const [depth, setDepth] = useState(1);
  const [scanningRoot, setScanningRoot] = useState<string>("");
  const [scannedCount, setScannedCount] = useState(0);
  const [rows, setRows] = useState<CandidateRow[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const toast = useToast();

  // Hydrate saved roots when dialog opens; pre-fill the textarea so the
  // operator's last roster shows up instead of a blank slate.
  useEffect(() => {
    if (!open) return;
    void api
      .scanRoots()
      .then((r) => {
        setSavedRoots(r.roots);
        setDefaultRoot(r.defaultRoot);
        setRootsText(r.roots.length > 0 ? r.roots.join("\n") : "");
      })
      .catch(() => {
        /* leave the textarea empty so placeholder shows */
      });
  }, [open]);

  // Tear everything down when the dialog closes — close the EventSource
  // explicitly because the browser holds the TCP connection open
  // otherwise. setState calls are deferred to a microtask so the
  // react-hooks/set-state-in-effect lint rule stays happy (project
  // convention — see app/apps/page.tsx for the same pattern).
  useEffect(() => {
    if (open) return;
    esRef.current?.close();
    esRef.current = null;
    void Promise.resolve().then(() => {
      setMode("config");
      setRows([]);
      setScannedCount(0);
      setScanningRoot("");
      setErrorMsg(null);
    });
  }, [open]);

  // Mount-lifetime cleanup: if the user navigates away mid-scan the
  // close-on-!open effect doesn't run, so the EventSource lingers and
  // keeps the TCP connection open. Mirror the close here so the
  // connection is always reaped.
  useEffect(() => () => {
    esRef.current?.close();
    esRef.current = null;
  }, []);

  const startScan = useCallback(() => {
    setMode("scanning");
    setRows([]);
    setScannedCount(0);
    setScanningRoot("");
    setErrorMsg(null);

    const trimmed = rootsText
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const params = new URLSearchParams();
    if (trimmed.length > 0) params.set("roots", trimmed.join("\n"));
    params.set("depth", String(depth));
    const url = `/api/apps/auto-detect/stream?${params.toString()}`;

    const es = new EventSource(url);
    esRef.current = es;
    let sawDone = false;

    es.onmessage = (ev) => {
      let data: DetectEvent;
      try {
        data = JSON.parse(ev.data) as DetectEvent;
      } catch {
        return;
      }
      if (data.type === "scanning") {
        setScanningRoot(data.root);
      } else if (data.type === "candidate") {
        setRows((prev) => {
          if (
            prev.some(
              (r) => r.candidate.absolutePath === data.candidate.absolutePath,
            )
          ) {
            return prev;
          }
          return [
            ...prev,
            {
              candidate: data.candidate,
              selected: !data.candidate.alreadyRegistered,
              editedName: data.candidate.name,
            },
          ];
        });
      } else if (data.type === "done") {
        sawDone = true;
        setScannedCount(data.scanned);
        setMode("review");
        es.close();
      }
      // `skipped` events are dropped — they're noise for the UI; we
      // could surface them as a "12 folders skipped" line in review
      // mode, but in practice operators don't care about non-repos.
    };
    es.onerror = () => {
      es.close();
      esRef.current = null;
      // The server closes the stream after `done`, which trips this
      // handler too. Distinguish by `sawDone`: if we got a done event,
      // the review mode is already set; otherwise it's a real failure.
      if (!sawDone) {
        setErrorMsg("Connection to scanner closed unexpectedly. Try again.");
        setMode("config");
      }
    };
  }, [rootsText, depth]);

  const stopScan = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
    setMode((m) => (m === "scanning" ? "review" : m));
  }, []);

  const newRows = useMemo(
    () => rows.filter((r) => !r.candidate.alreadyRegistered),
    [rows],
  );
  const selectedCount = useMemo(
    () =>
      rows.filter((r) => r.selected && !r.candidate.alreadyRegistered).length,
    [rows],
  );
  const allSelected = newRows.length > 0 && selectedCount === newRows.length;

  const toggleAll = (checked: boolean) => {
    setRows((prev) =>
      prev.map((r) =>
        r.candidate.alreadyRegistered ? r : { ...r, selected: checked },
      ),
    );
  };

  const updateRow = (path: string, patch: Partial<CandidateRow>) => {
    setRows((prev) =>
      prev.map((r) =>
        r.candidate.absolutePath === path ? { ...r, ...patch } : r,
      ),
    );
  };

  const confirm = useCallback(async () => {
    const selectedRows = rows.filter(
      (r) => r.selected && !r.candidate.alreadyRegistered,
    );
    if (selectedRows.length === 0) {
      toast("info", "Pick at least one app to add");
      return;
    }
    // Reject obviously-bad name edits before the round-trip.
    const badRow = selectedRows.find(
      (r) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(r.editedName),
    );
    if (badRow) {
      toast(
        "error",
        `Invalid name "${badRow.editedName}" — letters, digits, dot, dash, underscore; must start alphanumeric`,
      );
      return;
    }
    setMode("adding");
    try {
      // Persist the operator's scan roots if changed, so the next time
      // the dialog opens they don't have to retype.
      const cleanedRoots = rootsText
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const savedJoined = (savedRoots ?? []).join("\n");
      const newJoined = cleanedRoots.join("\n");
      if (savedJoined !== newJoined) {
        try {
          await api.updateScanRoots(cleanedRoots);
        } catch {
          /* not fatal — they'll just retype next time */
        }
      }

      const result = await api.bulkAddApps(
        selectedRows.map((r) => ({
          name: r.editedName,
          path: r.candidate.rawPath,
          description: r.candidate.description,
        })),
      );

      const addedNames = result.added.map((a) => a.name);
      if (result.added.length > 0) {
        toast(
          "success",
          `Added ${result.added.length} app${result.added.length === 1 ? "" : "s"}: ${addedNames.join(", ")}. Scanning with Claude…`,
        );
        onAdded?.();
      }
      if (result.failed.length > 0) {
        toast(
          "error",
          `${result.failed.length} failed: ${result.failed
            .map((f) => `${f.name} (${f.reason})`)
            .join(", ")}`,
        );
      }
      // Description scans run in the background — same pattern as the
      // single-app Add flow. Failures are silent; the heuristic
      // description from auto-detect remains.
      void Promise.allSettled(
        addedNames.map((n) => api.scanApp(n).catch(() => null)),
      );

      onOpenChange(false);
    } catch (e) {
      toast("error", (e as Error).message);
      setMode("review");
    }
  }, [rows, rootsText, savedRoots, toast, onAdded, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            Auto-detect apps
          </DialogTitle>
          <DialogDescription>
            Scan one or more parent directories for code repos and pick which to register.
          </DialogDescription>
        </DialogHeader>

        {mode === "config" && (
          <ConfigStep
            rootsText={rootsText}
            setRootsText={setRootsText}
            depth={depth}
            setDepth={setDepth}
            defaultRoot={defaultRoot}
            errorMsg={errorMsg}
          />
        )}

        {mode === "scanning" && (
          <ScanningStep
            scanningRoot={scanningRoot}
            candidateCount={rows.length}
            rows={rows}
          />
        )}

        {(mode === "review" || mode === "adding") && (
          <ReviewStep
            rows={rows}
            allSelected={allSelected}
            selectedCount={selectedCount}
            scannedCount={scannedCount}
            onToggleAll={toggleAll}
            onUpdateRow={updateRow}
            disabled={mode === "adding"}
          />
        )}

        <DialogFooter className="mt-2">
          {mode === "config" && (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={startScan}>
                <FolderSearch className="h-3.5 w-3.5" />
                Scan
              </Button>
            </>
          )}
          {mode === "scanning" && (
            <Button variant="outline" onClick={stopScan}>
              Stop & review
            </Button>
          )}
          {mode === "review" && (
            <>
              <Button variant="ghost" onClick={() => setMode("config")}>
                <RotateCcw className="h-3.5 w-3.5" />
                Re-scan
              </Button>
              <Button onClick={confirm} disabled={selectedCount === 0}>
                <Check className="h-3.5 w-3.5" />
                Add {selectedCount > 0 ? `${selectedCount} ` : ""}app
                {selectedCount === 1 ? "" : "s"}
              </Button>
            </>
          )}
          {mode === "adding" && (
            <Button disabled>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Adding…
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ─────────────────────────── steps ─────────────────────────── */

interface ConfigStepProps {
  rootsText: string;
  setRootsText: (v: string) => void;
  depth: number;
  setDepth: (v: number) => void;
  defaultRoot: string;
  errorMsg: string | null;
}

function ConfigStep({
  rootsText,
  setRootsText,
  depth,
  setDepth,
  defaultRoot,
  errorMsg,
}: ConfigStepProps) {
  return (
    <div className="grid gap-3 py-2">
      {errorMsg && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{errorMsg}</span>
        </div>
      )}
      <div className="grid gap-1.5">
        <Label htmlFor="scan-roots">Scan roots</Label>
        <Textarea
          id="scan-roots"
          value={rootsText}
          onChange={(e) => setRootsText(e.target.value)}
          rows={4}
          placeholder={defaultRoot ? `Default: ${defaultRoot}` : "../"}
          spellCheck={false}
          className="font-mono text-xs"
        />
        <p className="text-[11px] text-muted-foreground">
          One path per line. Empty = scan <code className="font-mono">{defaultRoot || "the bridge parent"}</code>.
          Relative paths resolve against the bridge folder.
        </p>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="scan-depth">Recursion depth</Label>
        <div className="flex items-center gap-2">
          {[1, 2, 3].map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDepth(d)}
              className={cn(
                "h-7 rounded-md border px-3 text-xs transition-colors",
                depth === d
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border bg-background hover:bg-accent",
              )}
            >
              {d}
            </button>
          ))}
          <span className="text-[11px] text-muted-foreground">
            {depth === 1 && "Only direct children of each root."}
            {depth === 2 && "Also descend one level into non-repo folders."}
            {depth === 3 && "Up to two levels deeper. Slower."}
          </span>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Monorepo workspaces (pnpm-workspace.yaml, lerna.json, turbo.json, nx.json) auto-expand <code className="font-mono">packages/</code>, <code className="font-mono">apps/</code>, <code className="font-mono">services/</code>, <code className="font-mono">libs/</code> regardless of depth.
        </p>
      </div>
    </div>
  );
}

interface ScanningStepProps {
  scanningRoot: string;
  candidateCount: number;
  rows: CandidateRow[];
}

function ScanningStep({ scanningRoot, candidateCount, rows }: ScanningStepProps) {
  return (
    <div className="grid gap-3 py-2">
      <div className="flex items-center gap-2 rounded-md border border-border bg-card p-3">
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium">
            Scanning… <span className="tabular-nums">{candidateCount}</span> candidate
            {candidateCount === 1 ? "" : "s"} so far
          </div>
          {scanningRoot && (
            <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
              {scanningRoot}
            </div>
          )}
        </div>
      </div>

      {rows.length > 0 && (
        <div className="max-h-[40vh] overflow-y-auto rounded-md border border-border">
          <ul className="divide-y divide-border">
            {rows.map((r) => (
              <li
                key={r.candidate.absolutePath}
                className="flex items-center gap-2 px-3 py-2 text-xs"
              >
                <CheckCircle2
                  className={cn(
                    "h-3.5 w-3.5 shrink-0",
                    r.candidate.alreadyRegistered ? "text-fg-dim" : "text-success",
                  )}
                />
                <span className="font-mono font-medium">{r.candidate.name}</span>
                <span className="truncate font-mono text-[11px] text-muted-foreground">
                  {r.candidate.rawPath}
                </span>
                {r.candidate.alreadyRegistered && (
                  <span className="ml-auto rounded-full bg-fg-dim/15 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-fg-dim">
                    registered
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

interface ReviewStepProps {
  rows: CandidateRow[];
  allSelected: boolean;
  selectedCount: number;
  scannedCount: number;
  onToggleAll: (checked: boolean) => void;
  onUpdateRow: (path: string, patch: Partial<CandidateRow>) => void;
  disabled: boolean;
}

function ReviewStep({
  rows,
  allSelected,
  selectedCount,
  scannedCount,
  onToggleAll,
  onUpdateRow,
  disabled,
}: ReviewStepProps) {
  const newRows = rows.filter((r) => !r.candidate.alreadyRegistered);
  const registeredRows = rows.filter((r) => r.candidate.alreadyRegistered);

  if (rows.length === 0) {
    return (
      <div className="grid gap-3 py-2">
        <div className="rounded-md border border-border bg-card p-6 text-center text-xs text-muted-foreground">
          No candidates found in {scannedCount} folder{scannedCount === 1 ? "" : "s"}.
          Try increasing depth or adding more roots.
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="text-muted-foreground">
          Found <strong className="text-foreground">{newRows.length}</strong> new
          {newRows.length === 1 ? " candidate" : " candidates"}
          {registeredRows.length > 0 && (
            <span> · {registeredRows.length} already registered</span>
          )}
          <span className="ml-1 text-fg-dim">({scannedCount} folder{scannedCount === 1 ? "" : "s"} scanned)</span>
        </span>
        {newRows.length > 1 && (
          <label className="inline-flex cursor-pointer items-center gap-1.5 select-none text-xs">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={(e) => onToggleAll(e.target.checked)}
              className="h-3.5 w-3.5 cursor-pointer accent-primary"
              disabled={disabled}
            />
            Select all
            <span className="text-fg-dim">
              ({selectedCount}/{newRows.length})
            </span>
          </label>
        )}
      </div>

      <div className="max-h-[50vh] overflow-y-auto rounded-md border border-border">
        <ul className="divide-y divide-border">
          {[...newRows, ...registeredRows].map((row) => (
            <CandidateRowItem
              key={row.candidate.absolutePath}
              row={row}
              onUpdateRow={onUpdateRow}
              disabled={disabled}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}

interface CandidateRowItemProps {
  row: CandidateRow;
  onUpdateRow: (path: string, patch: Partial<CandidateRow>) => void;
  disabled: boolean;
}

function CandidateRowItem({
  row,
  onUpdateRow,
  disabled,
}: CandidateRowItemProps) {
  const { candidate, selected, editedName } = row;
  const isRegistered = candidate.alreadyRegistered;
  return (
    <li
      className={cn(
        "flex items-start gap-3 px-3 py-2.5",
        isRegistered && "bg-fg-dim/5 opacity-70",
      )}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={(e) =>
          onUpdateRow(candidate.absolutePath, { selected: e.target.checked })
        }
        disabled={isRegistered || disabled}
        className="mt-1 h-3.5 w-3.5 cursor-pointer accent-primary disabled:cursor-not-allowed"
        aria-label={`Select ${candidate.name}`}
      />
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <Input
            value={editedName}
            onChange={(e) =>
              onUpdateRow(candidate.absolutePath, { editedName: e.target.value })
            }
            disabled={isRegistered || disabled}
            spellCheck={false}
            className="h-6 max-w-[180px] font-mono text-xs"
            aria-label="App name"
          />
          {isRegistered && (
            <span className="rounded-full bg-fg-dim/15 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-fg-dim">
              registered
            </span>
          )}
          {candidate.isMonorepoChild && (
            <span
              className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-primary"
              title="Workspace child of a monorepo root"
            >
              workspace
            </span>
          )}
          <span
            className="rounded-full bg-secondary px-1.5 py-0.5 text-[9px] font-mono text-fg-dim tabular-nums"
            title="Detection score (≥ 5 to qualify)"
          >
            {candidate.score}
          </span>
        </div>
        <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground" title={candidate.absolutePath}>
          {candidate.rawPath}
        </div>
        {candidate.description && (
          <p className="mt-1 line-clamp-2 text-[11px] text-foreground/80">
            {candidate.description}
          </p>
        )}
        {candidate.signals.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {candidate.signals.slice(0, 6).map((s) => (
              <span
                key={s}
                className="rounded border border-border bg-background px-1 py-0 font-mono text-[9px] text-fg-dim"
              >
                {s}
              </span>
            ))}
            {candidate.signals.length > 6 && (
              <span className="text-[9px] text-fg-dim">
                +{candidate.signals.length - 6}
              </span>
            )}
          </div>
        )}
      </div>
    </li>
  );
}
