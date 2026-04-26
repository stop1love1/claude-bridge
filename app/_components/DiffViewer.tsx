"use client";

import { useEffect, useState } from "react";
import { GitBranch, RotateCw, Copy, Check, AlertCircle } from "lucide-react";
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
import { useToast } from "./Toasts";

interface DiffPayload {
  kind: "worktree" | "live";
  cwd: string;
  diff: string;
  truncated?: boolean;
}

/**
 * Renders a unified `git diff HEAD` for a single agent run with very
 * lightweight syntax highlighting (added / removed / hunk header).
 */
function colorizeLine(line: string): { cls: string; text: string } {
  if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ")) {
    return { cls: "text-fg-dim", text: line };
  }
  if (line.startsWith("@@")) {
    return { cls: "text-info", text: line };
  }
  if (line.startsWith("+") && !line.startsWith("+++")) {
    return { cls: "text-success bg-success/5", text: line };
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    return { cls: "text-destructive bg-destructive/5", text: line };
  }
  return { cls: "text-foreground/80", text: line };
}

export function DiffViewer({
  taskId,
  sessionId,
  role,
  open,
  onClose,
}: {
  taskId: string;
  sessionId: string;
  role: string;
  open: boolean;
  onClose: () => void;
}) {
  const [data, setData] = useState<DiffPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const toast = useToast();

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.runDiff(taskId, sessionId);
      setData(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, taskId, sessionId]);

  const copyAll = async () => {
    if (!data?.diff) return;
    try {
      await navigator.clipboard.writeText(data.diff);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast("error", "Clipboard blocked");
    }
  };

  const lines = data?.diff ? data.diff.split("\n") : [];
  const isEmpty = !loading && !error && data && data.diff.trim().length === 0;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-5xl w-[95vw] max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch size={15} className="text-info" />
            Diff for <span className="font-mono text-foreground">{role}</span>
            <span className="text-fg-dim text-xs font-mono">{sessionId.slice(0, 8)}…</span>
          </DialogTitle>
          <DialogDescription>
            {data && (
              <span className="font-mono text-[11px]">
                {data.kind === "worktree" ? "worktree" : "live tree"} · {data.cwd}
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-auto rounded-md border border-border bg-background">
          {loading && (
            <div className="p-6 space-y-2">
              <div className="h-3 w-2/3 rounded bg-muted/60 animate-pulse" />
              <div className="h-3 w-3/4 rounded bg-muted/60 animate-pulse" />
              <div className="h-3 w-1/2 rounded bg-muted/60 animate-pulse" />
            </div>
          )}
          {error && (
            <div className="p-6 flex items-start gap-2 text-destructive text-sm">
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
              <div>
                <div className="font-medium">Could not load diff</div>
                <div className="text-xs text-destructive/80 font-mono mt-1 wrap-break-word">{error}</div>
              </div>
            </div>
          )}
          {isEmpty && (
            <div className="p-6 text-sm text-muted-foreground text-center">
              No uncommitted changes in this run&apos;s working tree.
            </div>
          )}
          {!loading && !error && lines.length > 0 && (
            <pre className="text-[11.5px] font-mono leading-snug">
              {lines.map((l, i) => {
                const { cls, text } = colorizeLine(l);
                return (
                  <div key={i} className={`px-3 ${cls}`}>
                    {text || " "}
                  </div>
                );
              })}
            </pre>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          {data?.truncated && (
            <span className="text-[11px] text-warning mr-auto">
              ⚠ truncated at 256 KB
            </span>
          )}
          <Button variant="ghost" size="sm" onClick={load} disabled={loading} title="Re-fetch diff">
            <RotateCw size={13} className={loading ? "animate-spin" : ""} />
            Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={copyAll} disabled={!data?.diff}>
            {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
            Copy
          </Button>
          <Button size="sm" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
