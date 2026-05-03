import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  FolderSearch,
  Loader2,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
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
import {
  useAutoDetectApps,
  useBulkAddApps,
} from "@/api/queries";
import { useToast } from "@/components/Toasts";
import type {
  App,
  AutoDetectResponse,
  DetectCandidate,
} from "@/api/types";
import { cn } from "@/lib/cn";

// TODO: when /api/apps/auto-detect/stream lands in the Go bridge,
// switch the scanning step to EventSource for incremental candidate
// display. Today the bridge only ships the one-shot
// POST /api/apps/auto-detect endpoint (currently a stub returning
// `{candidates: [], deferred: "..."}`), so we drive the dialog with a
// single round-trip instead of a stream.

type Mode = "config" | "scanning" | "review" | "adding" | "results";

interface Props {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  /** Fires after a successful bulk-add so the parent page can refetch. */
  onAdded?: () => void;
}

interface RowState {
  candidate: DetectCandidate;
  selected: boolean;
  /** User-edited registration name. Defaults to `candidate.name`. */
  editedName: string;
}

interface AddResult {
  added: { name: string }[];
  failed: { name: string; reason: string }[];
}

const APP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SCAN_ROOTS_KEY = "bridge.detect.scanRoots";

/**
 * Multi-step auto-detect modal. Closely mirrors the main repo's flow
 * (config → scanning → review → results) but talks to the Go bridge's
 * one-shot POST /api/apps/auto-detect endpoint instead of the SSE
 * stream. Scan roots persist in localStorage under
 * `bridge.detect.scanRoots` since the bridge has no `/api/settings/scan-roots`
 * port yet — this keeps the operator's roster between sessions in the
 * same browser without blocking on a backend round-trip.
 */
export function AutoDetectDialog({ open, onOpenChange, onAdded }: Props) {
  const toast = useToast();
  const detect = useAutoDetectApps();
  const bulkAdd = useBulkAddApps();

  const [mode, setMode] = useState<Mode>("config");
  const [scanRoots, setScanRoots] = useState<string[]>([""]);
  const [depth, setDepth] = useState(1);
  const [rows, setRows] = useState<RowState[]>([]);
  const [scannedCount, setScannedCount] = useState(0);
  const [deferred, setDeferred] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [addResult, setAddResult] = useState<AddResult | null>(null);

  // Hydrate persisted scan roots when the dialog opens. The bridge
  // doesn't expose a settings endpoint for these yet, so we keep them
  // browser-local until that lands.
  useEffect(() => {
    if (!open) return;
    try {
      const raw = window.localStorage.getItem(SCAN_ROOTS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed) && parsed.every((s) => typeof s === "string")) {
          setScanRoots(parsed.length > 0 ? (parsed as string[]) : [""]);
          return;
        }
      }
    } catch {
      /* ignore — fall through to default */
    }
    setScanRoots([""]);
  }, [open]);

  // Reset transient state on close so a re-open kicks a fresh flow.
  useEffect(() => {
    if (open) return;
    setMode("config");
    setRows([]);
    setScannedCount(0);
    setDeferred(null);
    setErrorMsg(null);
    setAddResult(null);
  }, [open]);

  const persistRoots = useCallback((next: string[]) => {
    try {
      const cleaned = next.map((s) => s.trim()).filter((s) => s.length > 0);
      window.localStorage.setItem(SCAN_ROOTS_KEY, JSON.stringify(cleaned));
    } catch {
      /* localStorage quota / disabled — silent */
    }
  }, []);

  const updateRoot = (i: number, v: string) => {
    setScanRoots((prev) => prev.map((r, idx) => (idx === i ? v : r)));
  };
  const addRoot = () => setScanRoots((prev) => [...prev, ""]);
  const removeRoot = (i: number) =>
    setScanRoots((prev) =>
      prev.length === 1 ? [""] : prev.filter((_, idx) => idx !== i),
    );

  const startScan = useCallback(async () => {
    setMode("scanning");
    setRows([]);
    setScannedCount(0);
    setDeferred(null);
    setErrorMsg(null);
    persistRoots(scanRoots);
    try {
      // The Go endpoint ignores the body today, but we keep the call
      // shape forward-compatible — once the heuristic ports it'll pick
      // up the cleaned roots / depth from a richer payload.
      const r: AutoDetectResponse = await detect.mutateAsync();
      setDeferred(r.deferred ?? null);
      setRows(
        (r.candidates ?? []).map((c) => ({
          candidate: c,
          selected: !c.alreadyRegistered,
          editedName: c.name,
        })),
      );
      setScannedCount((r.candidates ?? []).length);
      setMode("review");
    } catch (e) {
      setErrorMsg((e as Error).message);
      setMode("config");
    }
  }, [scanRoots, depth, persistRoots, detect]);
  // depth currently only feeds the persisted form — the backend stub
  // doesn't read it. Kept in deps so a future endpoint that does will
  // re-trigger correctly. (Touch reference to silence noUnusedLocals.)
  void depth;

  const newRows = useMemo(
    () => rows.filter((r) => !r.candidate.alreadyRegistered),
    [rows],
  );
  const registeredRows = useMemo(
    () => rows.filter((r) => r.candidate.alreadyRegistered),
    [rows],
  );
  const selectedCount = useMemo(
    () => newRows.filter((r) => r.selected).length,
    [newRows],
  );
  const allSelected = newRows.length > 0 && selectedCount === newRows.length;

  const updateRow = (path: string, patch: Partial<RowState>) => {
    setRows((prev) =>
      prev.map((r) =>
        r.candidate.absolutePath === path ? { ...r, ...patch } : r,
      ),
    );
  };

  const toggleAll = (next: boolean) => {
    setRows((prev) =>
      prev.map((r) =>
        r.candidate.alreadyRegistered ? r : { ...r, selected: next },
      ),
    );
  };

  const confirm = useCallback(async () => {
    const picked = newRows.filter((r) => r.selected);
    if (picked.length === 0) {
      toast.info("nothing selected", "pick at least one app");
      return;
    }
    const bad = picked.find((r) => !APP_NAME_RE.test(r.editedName));
    if (bad) {
      toast.error(
        "invalid name",
        `"${bad.editedName}" — letters, digits, dot, dash, underscore`,
      );
      return;
    }
    setMode("adding");
    try {
      const resp = await bulkAdd.mutateAsync(
        picked.map((r) => ({
          name: r.editedName,
          path: r.candidate.rawPath,
          description: r.candidate.description,
        })),
      );
      // The Go /api/apps/bulk endpoint replaces the whole registry
      // atomically — no per-row {added, failed} envelope. We synthesize
      // one by intersecting the request names with the response so the
      // results panel still surfaces what landed. If the future "merge
      // with diagnostics" port lands the projection becomes a no-op.
      const respNames = new Set<string>(
        (resp?.apps ?? []).map((a: App) => a.name),
      );
      const result: AddResult = {
        added: picked
          .filter((r) => respNames.has(r.editedName))
          .map((r) => ({ name: r.editedName })),
        failed: picked
          .filter((r) => !respNames.has(r.editedName))
          .map((r) => ({ name: r.editedName, reason: "not in response" })),
      };
      setAddResult(result);
      if (result.added.length > 0) onAdded?.();
      // If there was a clean win, don't make the operator click a
      // second button — collapse straight to the success toast.
      if (result.failed.length === 0) {
        toast.success(
          `added ${result.added.length} app${result.added.length === 1 ? "" : "s"}`,
        );
        onOpenChange(false);
        return;
      }
      setMode("results");
    } catch (e) {
      toast.error("bulk add failed", (e as Error).message);
      setMode("review");
    }
  }, [newRows, bulkAdd, toast, onAdded, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles size={14} className="text-primary" />
            auto-detect apps
          </DialogTitle>
          <DialogDescription>
            scan parent directories for code repos, then pick which to register.
          </DialogDescription>
        </DialogHeader>

        {mode === "config" && (
          <ConfigStep
            scanRoots={scanRoots}
            depth={depth}
            errorMsg={errorMsg}
            onUpdate={updateRoot}
            onAdd={addRoot}
            onRemove={removeRoot}
            onDepth={setDepth}
          />
        )}

        {mode === "scanning" && (
          <div className="rounded-sm border border-border bg-card p-4 text-center">
            <FolderSearch
              size={20}
              className="mx-auto mb-2 animate-pulse text-primary"
            />
            <p className="text-small text-muted-foreground">scanning…</p>
            <p className="mt-1 text-[11px] text-fg-dim">
              one-shot scan — incremental SSE streaming lands when the backend
              gets `/api/apps/auto-detect/stream`.
            </p>
          </div>
        )}

        {(mode === "review" || mode === "adding") && (
          <ReviewStep
            rows={rows}
            newRows={newRows}
            registeredRows={registeredRows}
            allSelected={allSelected}
            selectedCount={selectedCount}
            scannedCount={scannedCount}
            deferred={deferred}
            onToggleAll={toggleAll}
            onUpdateRow={updateRow}
            disabled={mode === "adding"}
          />
        )}

        {mode === "results" && addResult && (
          <ResultsStep result={addResult} />
        )}

        <DialogFooter>
          {mode === "config" && (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                cancel
              </Button>
              <Button onClick={() => void startScan()}>
                <FolderSearch size={12} />
                scan
              </Button>
            </>
          )}
          {mode === "scanning" && (
            <Button variant="outline" disabled>
              <Loader2 size={12} className="animate-spin" />
              scanning…
            </Button>
          )}
          {mode === "review" && (
            <>
              <Button variant="ghost" onClick={() => setMode("config")}>
                <RotateCcw size={12} />
                re-scan
              </Button>
              <Button
                onClick={() => void confirm()}
                disabled={selectedCount === 0}
              >
                <Check size={12} />
                add {selectedCount > 0 ? `${selectedCount} ` : ""}selected
              </Button>
            </>
          )}
          {mode === "adding" && (
            <Button disabled>
              <Loader2 size={12} className="animate-spin" />
              adding…
            </Button>
          )}
          {mode === "results" && (
            <>
              <Button variant="ghost" onClick={() => setMode("review")}>
                <RotateCcw size={12} />
                try again
              </Button>
              <Button onClick={() => onOpenChange(false)}>close</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ──────────────────────── steps ──────────────────────── */

interface ConfigStepProps {
  scanRoots: string[];
  depth: number;
  errorMsg: string | null;
  onUpdate: (i: number, v: string) => void;
  onAdd: () => void;
  onRemove: (i: number) => void;
  onDepth: (n: number) => void;
}

function ConfigStep({
  scanRoots,
  depth,
  errorMsg,
  onUpdate,
  onAdd,
  onRemove,
  onDepth,
}: ConfigStepProps) {
  return (
    <div className="grid gap-3 py-2">
      {/* Surface the documented gap so operators know why the list might be empty. */}
      <div className="rounded-sm border border-status-doing/40 bg-status-doing/10 p-2 text-[11px] text-status-doing">
        backend heuristic is a stub — listing may be empty until the scan port
        lands.
      </div>

      {errorMsg && (
        <div className="flex items-start gap-2 rounded-sm border border-status-blocked/40 bg-status-blocked/10 p-2 text-[11px] text-status-blocked">
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          <span>{errorMsg}</span>
        </div>
      )}

      <div className="grid gap-1.5">
        <Label>scan roots</Label>
        <div className="grid gap-1.5">
          {scanRoots.map((root, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <Input
                value={root}
                onChange={(e) => onUpdate(i, e.target.value)}
                placeholder="../"
                spellCheck={false}
                className="font-mono text-xs"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => onRemove(i)}
                disabled={scanRoots.length === 1 && root === ""}
                aria-label="remove scan root"
                title="remove scan root"
              >
                <Trash2 size={12} />
              </Button>
            </div>
          ))}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onAdd}
          className="w-fit"
        >
          <Plus size={12} />
          add scan root
        </Button>
        <p className="text-[11px] text-muted-foreground">
          one path per row. Empty = scan the bridge parent. Relative paths
          resolve against the bridge folder. Persisted to{" "}
          <code className="font-mono">localStorage</code> until the backend
          gets a settings endpoint.
        </p>
      </div>

      <div className="grid gap-1.5">
        <Label>recursion depth</Label>
        <div className="flex items-center gap-2">
          {[1, 2, 3].map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => onDepth(d)}
              className={cn(
                "h-7 rounded-sm border px-3 text-xs transition-colors",
                depth === d
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border bg-background hover:bg-accent",
              )}
            >
              {d}
            </button>
          ))}
          <span className="text-[11px] text-muted-foreground">
            {depth === 1 && "only direct children of each root."}
            {depth === 2 && "also descend one level into non-repo folders."}
            {depth === 3 && "up to two levels deeper. Slower."}
          </span>
        </div>
        <p className="text-[11px] text-fg-dim">
          depth is forwarded for forward-compat — the current backend stub
          ignores it.
        </p>
      </div>
    </div>
  );
}

interface ReviewStepProps {
  rows: RowState[];
  newRows: RowState[];
  registeredRows: RowState[];
  allSelected: boolean;
  selectedCount: number;
  scannedCount: number;
  deferred: string | null;
  onToggleAll: (next: boolean) => void;
  onUpdateRow: (path: string, patch: Partial<RowState>) => void;
  disabled: boolean;
}

function ReviewStep({
  rows,
  newRows,
  registeredRows,
  allSelected,
  selectedCount,
  scannedCount,
  deferred,
  onToggleAll,
  onUpdateRow,
  disabled,
}: ReviewStepProps) {
  if (rows.length === 0) {
    return (
      <div className="rounded-sm border border-dashed border-border bg-card/50 p-6 text-center text-small text-muted-foreground">
        no candidates found
        {scannedCount > 0 && ` in ${scannedCount} folder${scannedCount === 1 ? "" : "s"}`}
        .
        {deferred && (
          <p className="mt-2 font-mono text-[10px] tracking-wideish text-fg-dim">
            {deferred}
          </p>
        )}
      </div>
    );
  }
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
        <span className="text-muted-foreground">
          <span className="text-foreground">{newRows.length}</span> new
          {newRows.length === 1 ? " candidate" : " candidates"}
          {registeredRows.length > 0 && (
            <span> · {registeredRows.length} already registered</span>
          )}
        </span>
        {newRows.length > 1 && (
          <label className="inline-flex cursor-pointer items-center gap-1.5">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={(e) => onToggleAll(e.target.checked)}
              className="h-3.5 w-3.5 accent-accent"
              disabled={disabled}
            />
            <span className="font-mono text-micro uppercase tracking-wideish text-muted-foreground">
              select all
            </span>
            <span className="text-fg-dim">
              ({selectedCount}/{newRows.length})
            </span>
          </label>
        )}
      </div>

      <ul className="max-h-[50vh] divide-y divide-border overflow-y-auto rounded-sm border border-border">
        {[...newRows, ...registeredRows].map((row) => (
          <CandidateRowItem
            key={row.candidate.absolutePath}
            row={row}
            onUpdateRow={onUpdateRow}
            disabled={disabled}
          />
        ))}
      </ul>
    </>
  );
}

interface CandidateRowItemProps {
  row: RowState;
  onUpdateRow: (path: string, patch: Partial<RowState>) => void;
  disabled: boolean;
}

function CandidateRowItem({ row, onUpdateRow, disabled }: CandidateRowItemProps) {
  const { candidate, selected, editedName } = row;
  const isRegistered = candidate.alreadyRegistered;
  const nameInvalid = !isRegistered && !APP_NAME_RE.test(editedName);
  return (
    <li
      className={cn(
        "flex items-start gap-3 px-3 py-2",
        isRegistered && "opacity-60",
      )}
    >
      <input
        type="checkbox"
        checked={selected}
        disabled={isRegistered || disabled}
        onChange={(e) =>
          onUpdateRow(candidate.absolutePath, { selected: e.target.checked })
        }
        className="mt-1 h-3.5 w-3.5 cursor-pointer accent-accent disabled:cursor-not-allowed"
        aria-label={`Select ${candidate.name}`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <Input
            value={editedName}
            onChange={(e) =>
              onUpdateRow(candidate.absolutePath, { editedName: e.target.value })
            }
            disabled={isRegistered || disabled}
            spellCheck={false}
            aria-invalid={nameInvalid || undefined}
            aria-label="App name"
            className={cn(
              "h-6 max-w-[200px] font-mono text-xs",
              nameInvalid && "border-status-blocked",
            )}
          />
          {isRegistered && (
            <span className="rounded-full bg-muted/15 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wideish text-muted-foreground">
              registered
            </span>
          )}
          {candidate.isMonorepoChild && (
            <span
              className="rounded-full bg-primary/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wideish text-primary"
              title="Workspace child of a monorepo root"
            >
              workspace
            </span>
          )}
          <span className="rounded-full border border-border bg-card px-1.5 py-0.5 font-mono text-[9px] tabular-nums text-muted-foreground">
            score {candidate.score}
          </span>
        </div>
        <div
          className="mt-1 truncate font-mono text-[11px] text-muted-foreground"
          title={candidate.absolutePath}
        >
          {candidate.rawPath}
        </div>
        {candidate.description && (
          <p className="mt-1 line-clamp-2 text-[11px] text-foreground/80">
            {candidate.description}
          </p>
        )}
        {nameInvalid && (
          <p className="mt-1 text-[10px] text-status-blocked">
            invalid — letters, digits, dot, dash, underscore; must start
            alphanumeric
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

interface ResultsStepProps {
  result: AddResult;
}

function ResultsStep({ result }: ResultsStepProps) {
  return (
    <div className="grid gap-3 py-2">
      {result.added.length > 0 && (
        <div className="rounded-sm border border-status-done/40 bg-status-done/10 p-3">
          <div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-wideish text-status-done">
            <CheckCircle2 size={12} />
            added {result.added.length}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {result.added.map((a) => (
              <span
                key={a.name}
                className="inline-flex items-center gap-1 rounded-full bg-status-done/20 px-2 py-0.5 font-mono text-[10px] text-status-done"
              >
                <Check size={10} />
                {a.name}
              </span>
            ))}
          </div>
        </div>
      )}
      {result.failed.length > 0 && (
        <div className="rounded-sm border border-status-blocked/40 bg-status-blocked/10 p-3">
          <div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-wideish text-status-blocked">
            <X size={12} />
            failed {result.failed.length}
          </div>
          <ul className="grid gap-1">
            {result.failed.map((f) => (
              <li
                key={f.name}
                className="flex items-start gap-2 text-[11px] text-status-blocked"
              >
                <AlertCircle size={11} className="mt-0.5 shrink-0" />
                <span className="font-mono">{f.name}</span>
                <span className="text-fg-dim">— {f.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
