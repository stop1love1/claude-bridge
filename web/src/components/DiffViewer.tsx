import { useMemo, useState } from "react";
import {
  GitBranch,
  RotateCw,
  Copy,
  Check,
  AlertCircle,
  Search,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useRunDiff } from "@/api/queries";
import { useToast } from "@/components/Toasts";
import { cn } from "@/lib/cn";

// Lightweight unified-diff renderer. Splits the diff into per-file
// chunks (each starts with `diff --git`) so we can collapse them
// individually and run a header search filter. Lines are colored
// added/removed/hunk/context inline — no Prism / shiki to keep the
// bundle lean.

interface FileChunk {
  header: string;
  /** Full per-file body including the `diff --git ...` line. */
  body: string;
  /** Path inferred from the diff header (best-effort). */
  path: string;
}

function splitDiffByFile(diff: string): FileChunk[] {
  if (!diff.trim()) return [];
  const lines = diff.split("\n");
  const out: FileChunk[] = [];
  let buf: string[] = [];
  const flush = () => {
    if (buf.length === 0) return;
    const body = buf.join("\n");
    const head = buf[0] ?? "";
    // Pull the `b/<path>` token from `diff --git a/foo b/foo`.
    const m = /diff --git a\/(\S+) b\/(\S+)/.exec(head);
    const path = m ? m[2] : head;
    out.push({ header: head, body, path });
    buf = [];
  };
  for (const ln of lines) {
    if (ln.startsWith("diff --git ")) {
      flush();
    }
    buf.push(ln);
  }
  flush();
  return out;
}

function colorClass(line: string): string {
  if (
    line.startsWith("diff --git") ||
    line.startsWith("index ") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ")
  ) {
    return "text-muted";
  }
  if (line.startsWith("@@")) return "text-info";
  if (line.startsWith("+") && !line.startsWith("+++"))
    return "text-success bg-success/5";
  if (line.startsWith("-") && !line.startsWith("---"))
    return "text-destructive bg-destructive/5";
  return "text-fg/80";
}

interface DiffViewerProps {
  taskId: string;
  sessionId: string;
  role?: string;
  open: boolean;
  onClose: () => void;
}

export function DiffViewer({ open, onClose, ...rest }: DiffViewerProps) {
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      {open && <DiffViewerBody onClose={onClose} {...rest} />}
    </Dialog>
  );
}

function DiffViewerBody({
  taskId,
  sessionId,
  role,
  onClose,
}: Omit<DiffViewerProps, "open">) {
  const { data, isLoading, error, refetch, isFetching } = useRunDiff(
    taskId,
    sessionId,
  );
  const [copied, setCopied] = useState(false);
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const toast = useToast();

  const chunks = useMemo(
    () => (data?.diff ? splitDiffByFile(data.diff) : []),
    [data?.diff],
  );

  const filteredChunks = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return chunks;
    return chunks.filter((c) => c.path.toLowerCase().includes(q));
  }, [chunks, filter]);

  const isEmpty =
    !isLoading && !error && data && data.diff.trim().length === 0;

  const copyAll = async () => {
    if (!data?.diff) return;
    try {
      await navigator.clipboard.writeText(data.diff);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Clipboard blocked");
    }
  };

  const toggle = (path: string) =>
    setCollapsed((m) => ({ ...m, [path]: !m[path] }));

  return (
    <DialogContent className="max-w-5xl w-[95vw] max-h-[90vh] flex flex-col">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <GitBranch size={15} className="text-info" />
          diff for{" "}
          {role && <span className="font-mono text-fg normal-case">{role}</span>}
          <span className="text-muted text-xs font-mono">
            {sessionId.slice(0, 8)}…
          </span>
        </DialogTitle>
        <DialogDescription>
          {data && (
            <span className="font-mono text-[11px]">
              {data.kind === "worktree" ? "worktree" : "live tree"} · {data.cwd}
            </span>
          )}
        </DialogDescription>
      </DialogHeader>

      {chunks.length > 0 && (
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search
              size={12}
              className="absolute left-2 top-1/2 -translate-y-1/2 text-muted pointer-events-none"
            />
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="filter by file path"
              className="pl-7"
            />
          </div>
          <span className="text-[11px] font-mono text-muted">
            {filteredChunks.length}/{chunks.length} files
          </span>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto rounded-sm border border-border bg-bg">
        {isLoading && (
          <div className="p-6 space-y-2">
            <div className="h-3 w-2/3 rounded bg-surface-2 animate-pulse" />
            <div className="h-3 w-3/4 rounded bg-surface-2 animate-pulse" />
            <div className="h-3 w-1/2 rounded bg-surface-2 animate-pulse" />
          </div>
        )}
        {error && (
          <div className="p-6 flex items-start gap-2 text-destructive text-sm">
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            <div>
              <div className="font-medium">Could not load diff</div>
              <div className="text-xs text-destructive/80 font-mono mt-1 break-words">
                {(error as Error).message}
              </div>
            </div>
          </div>
        )}
        {isEmpty && (
          <div className="p-6 text-sm text-muted text-center">
            no changes recorded for this run.
          </div>
        )}
        {!isLoading && !error && filteredChunks.length > 0 && (
          <div className="text-[11.5px] font-mono leading-snug">
            {filteredChunks.map((c) => {
              const isCollapsed = !!collapsed[c.path];
              const lines = c.body.split("\n");
              return (
                <div
                  key={c.path}
                  className="border-b border-border/60 last:border-b-0"
                >
                  <button
                    type="button"
                    onClick={() => toggle(c.path)}
                    className="w-full flex items-center gap-1.5 px-3 py-1.5 sticky top-0 bg-surface text-left hover:bg-surface-2 z-10"
                  >
                    {isCollapsed ? (
                      <ChevronRight size={11} className="text-muted" />
                    ) : (
                      <ChevronDown size={11} className="text-muted" />
                    )}
                    <span className="text-fg truncate">{c.path}</span>
                  </button>
                  {!isCollapsed && (
                    <pre className="m-0">
                      {lines.map((l, i) => (
                        <div key={i} className={cn("px-3", colorClass(l))}>
                          {l || " "}
                        </div>
                      ))}
                    </pre>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <DialogFooter className="gap-2 sm:gap-2">
        {data?.truncated && (
          <span className="text-[11px] text-warning mr-auto">
            ⚠ truncated at 256 KB
          </span>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void refetch()}
          disabled={isFetching}
          title="Re-fetch diff"
        >
          <RotateCw size={13} className={cn(isFetching && "animate-spin")} />
          Refresh
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void copyAll()}
          disabled={!data?.diff}
        >
          {copied ? (
            <Check size={13} className="text-success" />
          ) : (
            <Copy size={13} />
          )}
          Copy
        </Button>
        <Button size="sm" onClick={onClose}>
          Close
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
