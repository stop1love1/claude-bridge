import { useEffect, useMemo, useState } from "react";
import { AlertCircle, FolderSearch } from "lucide-react";
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
import {
  useAutoDetectApps,
  useBulkAddApps,
} from "@/api/queries";
import { useToast } from "@/components/Toasts";
import type { AutoDetectResponse, DetectCandidate } from "@/api/types";
import { cn } from "@/lib/cn";

interface Props {
  open: boolean;
  onOpenChange: (next: boolean) => void;
}

interface RowState {
  candidate: DetectCandidate;
  selected: boolean;
  editedName: string;
}

const APP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Auto-detect runs a one-shot POST /api/apps/auto-detect (no SSE in
 * the Go bridge yet). The endpoint is a stub today — the response
 * carries `candidates: []` plus a `deferred` field. We surface that
 * note inline so the operator knows why their list might be empty.
 */
export function AutoDetectDialog({ open, onOpenChange }: Props) {
  const toast = useToast();
  const detect = useAutoDetectApps();
  const bulkAdd = useBulkAddApps();
  const [rows, setRows] = useState<RowState[]>([]);
  const [deferred, setDeferred] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Trigger the heuristic once when the dialog opens. Reset state on
  // close so a re-open kicks a fresh scan.
  useEffect(() => {
    if (!open) {
      setRows([]);
      setDeferred(null);
      setErrorMsg(null);
      return;
    }
    void (async () => {
      try {
        const r: AutoDetectResponse = await detect.mutateAsync();
        setDeferred(r.deferred ?? null);
        setRows(
          (r.candidates ?? []).map((c) => ({
            candidate: c,
            selected: !c.alreadyRegistered,
            editedName: c.name,
          })),
        );
      } catch (e) {
        setErrorMsg((e as Error).message);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const newRows = useMemo(
    () => rows.filter((r) => !r.candidate.alreadyRegistered),
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

  const confirm = async () => {
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
    try {
      await bulkAdd.mutateAsync(
        picked.map((r) => ({
          name: r.editedName,
          path: r.candidate.rawPath,
          description: r.candidate.description,
        })),
      );
      toast.success(
        `added ${picked.length} app${picked.length === 1 ? "" : "s"}`,
      );
      onOpenChange(false);
    } catch (e) {
      toast.error("bulk add failed", (e as Error).message);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>auto-detect apps</DialogTitle>
          <DialogDescription>
            scan parent directories for code repos, then pick which to register.
          </DialogDescription>
        </DialogHeader>

        {/* Surface the documented gap so operators know why the list is empty. */}
        <div className="rounded-sm border border-status-doing/40 bg-status-doing/10 p-2 text-[11px] text-status-doing">
          backend heuristic is a stub — listing may be empty until the scan
          port lands.
        </div>

        {detect.isPending && (
          <div className="rounded-sm border border-border bg-surface p-4 text-center">
            <FolderSearch
              size={20}
              className="mx-auto mb-2 animate-pulse text-accent"
            />
            <p className="text-small text-muted">scanning…</p>
          </div>
        )}

        {errorMsg && (
          <div className="flex items-start gap-2 rounded-sm border border-status-blocked/40 bg-status-blocked/10 p-2 text-[11px] text-status-blocked">
            <AlertCircle size={12} className="mt-0.5 shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}

        {!detect.isPending && rows.length === 0 && !errorMsg && (
          <div className="rounded-sm border border-dashed border-border bg-surface/50 p-6 text-center text-small text-muted">
            no candidates found.
            {deferred && (
              <p className="mt-2 font-mono text-[10px] tracking-wideish text-muted-2">
                {deferred}
              </p>
            )}
          </div>
        )}

        {rows.length > 0 && (
          <>
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-muted">
                <span className="text-fg">{newRows.length}</span> new
                {newRows.length === 1 ? " candidate" : " candidates"}
              </span>
              {newRows.length > 1 && (
                <label className="inline-flex cursor-pointer items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={(e) => toggleAll(e.target.checked)}
                    className="h-3.5 w-3.5 accent-accent"
                  />
                  <span className="font-mono text-micro uppercase tracking-wideish text-muted">
                    select all
                  </span>
                </label>
              )}
            </div>

            <ul className="max-h-[50vh] divide-y divide-border overflow-y-auto rounded-sm border border-border">
              {rows.map((row) => (
                <li
                  key={row.candidate.absolutePath}
                  className={cn(
                    "flex items-start gap-3 px-3 py-2",
                    row.candidate.alreadyRegistered && "opacity-60",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={row.selected}
                    disabled={row.candidate.alreadyRegistered}
                    onChange={(e) =>
                      updateRow(row.candidate.absolutePath, {
                        selected: e.target.checked,
                      })
                    }
                    className="mt-1 h-3.5 w-3.5 cursor-pointer accent-accent"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Input
                        value={row.editedName}
                        onChange={(e) =>
                          updateRow(row.candidate.absolutePath, {
                            editedName: e.target.value,
                          })
                        }
                        disabled={row.candidate.alreadyRegistered}
                        spellCheck={false}
                        className="h-6 max-w-[200px]"
                      />
                      {row.candidate.alreadyRegistered && (
                        <span className="rounded-full bg-muted/15 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wideish text-muted">
                          registered
                        </span>
                      )}
                      <span className="rounded-full border border-border bg-surface px-1.5 py-0.5 font-mono text-[9px] tabular-nums text-muted">
                        score {row.candidate.score}
                      </span>
                    </div>
                    <div
                      className="mt-1 truncate font-mono text-[11px] text-muted"
                      title={row.candidate.absolutePath}
                    >
                      {row.candidate.rawPath}
                    </div>
                    {row.candidate.description && (
                      <p className="mt-1 line-clamp-2 text-[11px] text-fg/80">
                        {row.candidate.description}
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={bulkAdd.isPending}
          >
            cancel
          </Button>
          <Button
            onClick={() => void confirm()}
            disabled={bulkAdd.isPending || selectedCount === 0}
          >
            {bulkAdd.isPending
              ? "adding…"
              : `add ${selectedCount > 0 ? `${selectedCount} ` : ""}selected`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
