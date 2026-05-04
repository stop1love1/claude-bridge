"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  GitBranch,
  GitCommit,
  RotateCw,
  Copy,
  Check,
  AlertCircle,
  ChevronRight,
  ChevronDown,
  FileDiff,
  FileText,
  FileCode,
  FileJson,
  FileType2,
  ArrowRight,
  Folder,
  FolderOpen,
  Sparkles,
  Loader2,
} from "lucide-react";
import { api } from "@/libs/client/api";
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

interface FileHunk {
  header: string;
  lines: string[];
}

export interface FileDiffEntry {
  /** Canonical post-image path — what most reviewers care about ("where the change ended up"). */
  path: string;
  /** Pre-image path for renames; null otherwise. */
  oldPath: string | null;
  status: "added" | "deleted" | "modified" | "renamed";
  hunks: FileHunk[];
  added: number;
  removed: number;
  /** Full raw diff for this file, including the diff/index/+++/--- headers — used by Copy. */
  raw: string;
}

/**
 * Parse a `git diff` blob into per-file entries. The unified diff
 * starts each file with `diff --git a/<path> b/<path>` and continues
 * until the next `diff --git` (or EOF). Within each file:
 *   - `index <hash>..<hash> <mode>` — metadata, ignored for our shape
 *   - `--- a/<path>` / `+++ b/<path>` — pre/post paths. `--- /dev/null`
 *     means added; `+++ /dev/null` means deleted.
 *   - `@@ ... @@` — start of a hunk; subsequent lines are body until
 *     the next `@@` or end of file.
 *
 * Renames produce `rename from`/`rename to` lines instead of paths in
 * `---`/`+++`. Pure-rename (no body) cases still produce a single
 * entry with zero hunks.
 *
 * Defensive: any input that doesn't start with `diff --git` falls
 * through as a single synthetic entry so the pane still has something
 * to show (e.g. binary diff summaries, or our own truncation marker).
 */
export function parseUnifiedDiff(diff: string): FileDiffEntry[] {
  const out: FileDiffEntry[] = [];
  if (!diff.trim()) return out;

  const blocks = diff.split(/\n(?=diff --git )/g);
  for (const block of blocks) {
    if (!block.startsWith("diff --git ")) {
      // Tail / unknown content — surface as a synthetic entry so it's
      // visible in the file list rather than swallowed.
      if (block.trim().length > 0) {
        out.push({
          path: "(other)",
          oldPath: null,
          status: "modified",
          hunks: [{ header: "", lines: block.split("\n") }],
          added: 0,
          removed: 0,
          raw: block,
        });
      }
      continue;
    }
    const lines = block.split("\n");
    let path = "";
    let oldPath: string | null = null;
    let status: FileDiffEntry["status"] = "modified";
    const hunks: FileHunk[] = [];
    let curHunk: FileHunk | null = null;
    let added = 0;
    let removed = 0;
    let isAddition = false;
    let isDeletion = false;

    // Pull paths from the `diff --git a/<x> b/<y>` header — robust
    // against quoted paths with spaces (`a/"path with spaces"`).
    const headerMatch = /^diff --git (?:"([^"]+)"|(\S+)) (?:"([^"]+)"|(\S+))/.exec(lines[0] ?? "");
    if (headerMatch) {
      const a = (headerMatch[1] ?? headerMatch[2] ?? "").replace(/^a\//, "");
      const b = (headerMatch[3] ?? headerMatch[4] ?? "").replace(/^b\//, "");
      path = b || a;
      if (a && b && a !== b) oldPath = a;
    }

    for (let i = 1; i < lines.length; i++) {
      const ln = lines[i];
      if (ln.startsWith("rename from ")) {
        oldPath = ln.slice("rename from ".length);
        status = "renamed";
        continue;
      }
      if (ln.startsWith("rename to ")) {
        path = ln.slice("rename to ".length);
        status = "renamed";
        continue;
      }
      if (ln.startsWith("new file mode")) isAddition = true;
      if (ln.startsWith("deleted file mode")) isDeletion = true;
      if (ln.startsWith("--- ")) {
        const p = ln.slice(4);
        if (p === "/dev/null") isAddition = true;
        else oldPath = oldPath ?? p.replace(/^a\//, "");
        continue;
      }
      if (ln.startsWith("+++ ")) {
        const p = ln.slice(4);
        if (p === "/dev/null") isDeletion = true;
        else path = path || p.replace(/^b\//, "");
        continue;
      }
      if (ln.startsWith("@@")) {
        curHunk = { header: ln, lines: [] };
        hunks.push(curHunk);
        continue;
      }
      if (curHunk) {
        curHunk.lines.push(ln);
        if (ln.startsWith("+") && !ln.startsWith("+++")) added++;
        else if (ln.startsWith("-") && !ln.startsWith("---")) removed++;
      }
    }

    if (status === "modified") {
      if (isAddition) status = "added";
      else if (isDeletion) status = "deleted";
    }

    out.push({
      path: path || oldPath || "(unknown)",
      oldPath: oldPath && oldPath !== path ? oldPath : null,
      status,
      hunks,
      added,
      removed,
      raw: block,
    });
  }
  return out;
}

/**
 * Build a directory tree from a flat list of file paths. Mirrors the
 * left-side file pane in GitHub / Bitbucket / IDE review tools. Each
 * directory node aggregates child + / - counts so an operator can
 * see at a glance which subtree carries the bulk of the change.
 */
export interface TreeDir {
  kind: "dir";
  name: string;
  fullPath: string;
  children: TreeNode[];
  added: number;
  removed: number;
  fileCount: number;
}
export interface TreeFile {
  kind: "file";
  name: string;
  fullPath: string;
  entry: FileDiffEntry;
}
export type TreeNode = TreeDir | TreeFile;

export function buildFileTree(entries: FileDiffEntry[]): TreeDir {
  const root: TreeDir = {
    kind: "dir",
    name: "",
    fullPath: "",
    children: [],
    added: 0,
    removed: 0,
    fileCount: 0,
  };
  for (const entry of entries) {
    const parts = entry.path.split("/").filter(Boolean);
    let cursor: TreeDir = root;
    for (let i = 0; i < parts.length; i++) {
      const isLast = i === parts.length - 1;
      const segment = parts[i];
      if (isLast) {
        cursor.children.push({
          kind: "file",
          name: segment,
          fullPath: entry.path,
          entry,
        });
        cursor.fileCount += 1;
      } else {
        const fullPath = parts.slice(0, i + 1).join("/");
        let next = cursor.children.find(
          (c) => c.kind === "dir" && c.name === segment,
        ) as TreeDir | undefined;
        if (!next) {
          next = {
            kind: "dir",
            name: segment,
            fullPath,
            children: [],
            added: 0,
            removed: 0,
            fileCount: 0,
          };
          cursor.children.push(next);
        }
        cursor = next;
      }
    }
  }

  // Roll counts up + sort: dirs before files, then alphabetical.
  const finalize = (dir: TreeDir): { added: number; removed: number; fileCount: number } => {
    let added = 0;
    let removed = 0;
    let count = 0;
    for (const child of dir.children) {
      if (child.kind === "file") {
        added += child.entry.added;
        removed += child.entry.removed;
        count += 1;
      } else {
        const sub = finalize(child);
        added += sub.added;
        removed += sub.removed;
        count += sub.fileCount;
      }
    }
    dir.children.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    dir.added += added;
    dir.removed += removed;
    dir.fileCount += count;
    return { added, removed, fileCount: count };
  };
  finalize(root);
  return root;
}

/**
 * Squash dirs that have a single dir child — `app/components/ui` shows
 * as one entry rather than three nested toggles when none of the
 * intermediate directories carry their own files. Standard behavior
 * for GitHub / VS Code / Bitbucket diff trees.
 */
export function squashSingleDir(node: TreeDir): TreeDir {
  if (
    node.children.length === 1 &&
    node.children[0].kind === "dir" &&
    node.fileCount === node.children[0].fileCount
  ) {
    const child = node.children[0];
    const merged: TreeDir = {
      ...child,
      name: node.name ? `${node.name}/${child.name}` : child.name,
      fullPath: child.fullPath,
    };
    return squashSingleDir(merged);
  }
  return {
    ...node,
    children: node.children.map((c) => (c.kind === "dir" ? squashSingleDir(c) : c)),
  };
}

interface DiffViewerProps {
  taskId: string;
  sessionId: string;
  role: string;
  repo?: string;
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
  repo,
  onClose,
}: Omit<DiffViewerProps, "open">) {
  const [data, setData] = useState<DiffPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // Commit composer state — user types or generates a message, then
  // commits via POST /commit. We deliberately don't auto-fill the
  // message on mount: the operator should always confirm wording
  // before a commit lands.
  const [commitMsg, setCommitMsg] = useState("");
  const [committing, setCommitting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [pushAfter, setPushAfter] = useState(false);
  const toast = useToast();

  useEffect(() => {
    const ac = new AbortController();
    api.runDiff(taskId, sessionId, { signal: ac.signal })
      .then((r) => {
        if (ac.signal.aborted) return;
        setData(r);
        setLoading(false);
      })
      .catch((e) => {
        if (ac.signal.aborted) return;
        setError((e as Error).message);
        setLoading(false);
      });
    return () => ac.abort();
  }, [taskId, sessionId, attempt]);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    setAttempt((a) => a + 1);
  }, []);

  // Hoist data?.diff to a stable local so the React Compiler infers the
  // narrowest dependency rather than the whole `data` object.
  const dataDiff = data?.diff;
  const entries = useMemo(
    () => (dataDiff ? parseUnifiedDiff(dataDiff) : []),
    [dataDiff],
  );
  const tree = useMemo(
    () => (entries.length > 0 ? squashSingleDir(buildFileTree(entries)) : null),
    [entries],
  );
  // Derive default selection during render — avoids set-state-in-effect.
  // When the user hasn't picked a file yet, fall back to entries[0].
  const [pickedPath, setPickedPath] = useState<string | null>(null);
  const selected =
    entries.find((e) => e.path === pickedPath) ?? entries[0] ?? null;
  const selectedPath = selected?.path ?? null;
  const setSelectedPath = setPickedPath;

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

  const generate = useCallback(async () => {
    if (generating) return;
    setGenerating(true);
    try {
      const r = await api.suggestCommit(taskId, sessionId);
      setCommitMsg(r.message);
    } catch (e) {
      toast("error", `Suggest failed: ${(e as Error).message}`);
    } finally {
      setGenerating(false);
    }
  }, [taskId, sessionId, generating, toast]);

  const commit = useCallback(async () => {
    const msg = commitMsg.trim();
    if (!msg || committing) return;
    setCommitting(true);
    try {
      const r = await api.commitRun(taskId, sessionId, { message: msg, push: pushAfter });
      if (!r.ok) {
        toast("error", r.error ? `${r.message}: ${r.error}` : r.message);
        return;
      }
      toast("success", r.message);
      setCommitMsg("");
      // Refresh the diff so the just-committed changes drop out of
      // the working-tree view immediately.
      setLoading(true);
      setError(null);
      setAttempt((a) => a + 1);
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setCommitting(false);
    }
  }, [taskId, sessionId, commitMsg, committing, pushAfter, toast]);

  const isEmpty = !loading && !error && data && data.diff.trim().length === 0;
  const canCommit = !!commitMsg.trim() && !committing && entries.length > 0;

  return (
    <DialogContent className="max-w-6xl w-[95vw] max-h-[90vh] flex flex-col">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <GitBranch size={15} className="text-info" />
          Diff{repo ? ` for ` : ` for `}
          <span className="font-mono text-foreground">{repo ?? role}</span>
          {repo && (
            <span className="text-fg-dim text-xs font-mono">via {role} · {sessionId.slice(0, 8)}…</span>
          )}
          {!repo && (
            <span className="text-fg-dim text-xs font-mono">{sessionId.slice(0, 8)}…</span>
          )}
        </DialogTitle>
        <DialogDescription>
          {data && (
            <span className="font-mono text-[11px]">
              {data.kind === "worktree" ? "worktree" : "live tree"} · {data.cwd}
              {entries.length > 0 && (
                <>
                  {" "}· {entries.length} file{entries.length === 1 ? "" : "s"} ·
                  <span className="text-success"> +{entries.reduce((s, e) => s + e.added, 0)}</span>
                  {" "}/<span className="text-destructive"> -{entries.reduce((s, e) => s + e.removed, 0)}</span>
                </>
              )}
            </span>
          )}
        </DialogDescription>
      </DialogHeader>

      {/* Commit composer — sits above the file tree / hunks split so
          it's always visible. Mirrors VSCode's CHANGES panel: textarea
          + Generate (sparkle) + Commit. Disabled when there's nothing
          changed in the working tree. */}
      <div className="rounded-md border border-border bg-background p-2 space-y-1.5">
        <div className="relative">
          <textarea
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            placeholder={
              entries.length === 0
                ? "Nothing to commit"
                : `Message (Ctrl+Enter to commit) — ${entries.length} file${entries.length === 1 ? "" : "s"} changed`
            }
            disabled={entries.length === 0 || committing}
            rows={2}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                e.preventDefault();
                if (canCommit) void commit();
              }
            }}
            className="w-full bg-transparent border border-border rounded px-2 py-1.5 pr-8 text-[12px] resize-none focus:outline-none focus:border-primary/60 placeholder:text-muted-foreground/70 disabled:opacity-50"
          />
          <button
            type="button"
            onClick={generate}
            disabled={generating || entries.length === 0}
            className="absolute right-1.5 top-1.5 inline-flex items-center justify-center h-6 w-6 rounded text-fg-dim hover:text-primary hover:bg-primary/10 disabled:opacity-40 disabled:cursor-not-allowed"
            title="Auto-generate message from diff"
            aria-label="Generate commit message"
          >
            {generating ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
          </button>
        </div>
        <div className="flex items-center gap-2">
          <label className="inline-flex items-center gap-1.5 text-[11px] text-fg-dim cursor-pointer select-none">
            <input
              type="checkbox"
              checked={pushAfter}
              onChange={(e) => setPushAfter(e.target.checked)}
              className="h-3 w-3 rounded border-border accent-primary"
            />
            Push after commit
          </label>
          <Button
            size="sm"
            onClick={commit}
            disabled={!canCommit}
            className="ml-auto"
            title={canCommit ? "Commit (Ctrl+Enter)" : "Type a message first"}
          >
            {committing ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <GitCommit size={13} />
            )}
            Commit
          </Button>
        </div>
      </div>

      <div className="flex-1 min-h-0 grid grid-cols-[minmax(220px,32%)_1fr] gap-3 overflow-hidden">
        {/* Sidebar: file tree */}
        <aside className="min-h-0 overflow-auto rounded-md border border-border bg-background">
          {loading && (
            <div className="p-3 space-y-2">
              <div className="h-3 w-3/4 rounded bg-muted/60 animate-pulse" />
              <div className="h-3 w-2/3 rounded bg-muted/60 animate-pulse" />
              <div className="h-3 w-1/2 rounded bg-muted/60 animate-pulse" />
            </div>
          )}
          {!loading && tree && (
            <FileTreeView
              tree={tree}
              selectedPath={selectedPath}
              onSelect={setSelectedPath}
            />
          )}
          {!loading && !error && entries.length === 0 && (
            <div className="p-4 text-[11px] text-muted-foreground italic">
              No files changed.
            </div>
          )}
        </aside>

        {/* Main pane: hunks for the selected file */}
        <div className="min-h-0 overflow-auto rounded-md border border-border bg-background">
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
          {selected && !loading && !error && (
            <FileDiffPane entry={selected} />
          )}
        </div>
      </div>

      <DialogFooter className="gap-2 sm:gap-2">
        {data?.truncated && (
          <span className="text-[11px] text-warning mr-auto">
            ⚠ truncated at 256 KB
          </span>
        )}
        <Button variant="ghost" size="sm" onClick={refresh} disabled={loading} title="Re-fetch diff">
          <RotateCw size={13} className={loading ? "animate-spin" : ""} />
          Refresh
        </Button>
        <Button variant="outline" size="sm" onClick={copyAll} disabled={!data?.diff}>
          {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
          Copy all
        </Button>
        <Button size="sm" onClick={onClose}>Close</Button>
      </DialogFooter>
    </DialogContent>
  );
}

/* ─────────────────────────── File tree sidebar ─────────────────────────── */

/**
 * File-type icon picked from the path's extension. Mirrors the
 * VSCode "Seti / Material Icon" convention loosely: TS / TSX get a
 * cyan code icon, JS / MJS / CJS get a yellow code icon, JSON gets
 * the braces icon, MD / TXT get the document icon, .env gets the
 * type icon. Anything else falls back to the generic FileText.
 *
 * Returning a component (not JSX) lets the caller pass `size` /
 * className without a wrapping span.
 */
function FileTypeIcon({ name, size = 12 }: { name: string; size?: number }) {
  const ext = (name.match(/\.([^.]+)$/)?.[1] ?? "").toLowerCase();
  switch (ext) {
    case "tsx":
    case "jsx":
      return <FileCode size={size} className="text-cyan-400 shrink-0" />;
    case "ts":
    case "mts":
    case "cts":
      return <FileCode size={size} className="text-blue-400 shrink-0" />;
    case "js":
    case "mjs":
    case "cjs":
      return <FileCode size={size} className="text-yellow-400 shrink-0" />;
    case "json":
    case "jsonc":
      return <FileJson size={size} className="text-orange-400 shrink-0" />;
    case "md":
    case "mdx":
    case "txt":
      return <FileText size={size} className="text-fg-dim shrink-0" />;
    case "yaml":
    case "yml":
    case "toml":
    case "env":
    case "example":
      return <FileType2 size={size} className="text-yellow-300 shrink-0" />;
    case "css":
    case "scss":
    case "sass":
    case "less":
      return <FileCode size={size} className="text-pink-400 shrink-0" />;
    case "html":
    case "svg":
      return <FileCode size={size} className="text-orange-300 shrink-0" />;
    case "py":
      return <FileCode size={size} className="text-emerald-400 shrink-0" />;
    case "go":
      return <FileCode size={size} className="text-sky-300 shrink-0" />;
    case "rs":
      return <FileCode size={size} className="text-orange-500 shrink-0" />;
    default:
      return <FileText size={size} className="text-fg-dim shrink-0" />;
  }
}

/**
 * Single-letter VSCode-style status badge. Sits on the right edge of
 * a file row and is colored to match the CHANGES panel: yellow M,
 * green A, red D, blue R.
 */
function StatusBadge({ status }: { status: FileDiffEntry["status"] }) {
  const map: Record<FileDiffEntry["status"], { letter: string; cls: string; label: string }> = {
    modified: { letter: "M", cls: "text-yellow-400", label: "Modified" },
    added:    { letter: "A", cls: "text-success",    label: "Added" },
    deleted:  { letter: "D", cls: "text-destructive",label: "Deleted" },
    renamed:  { letter: "R", cls: "text-info",       label: "Renamed" },
  };
  const m = map[status];
  return (
    <span
      className={`text-[10px] font-bold tabular-nums shrink-0 ${m.cls}`}
      aria-label={m.label}
      title={m.label}
    >
      {m.letter}
    </span>
  );
}

export function FileTreeView({
  tree,
  selectedPath,
  onSelect,
}: {
  tree: TreeDir;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  return (
    <div>
      {/* VSCode-style "Changes" header — pinned to the top of the
          sidebar so the count and aggregate +/- are always visible
          even after scrolling deep into a long tree. */}
      <header className="sticky top-0 z-10 px-2 py-1.5 bg-background/95 backdrop-blur border-b border-border flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-semibold text-fg-dim">
        <span>Changes</span>
        <span className="ml-auto inline-flex items-center gap-2">
          {tree.added > 0 && <span className="text-success font-mono normal-case">+{tree.added}</span>}
          {tree.removed > 0 && <span className="text-destructive font-mono normal-case">-{tree.removed}</span>}
          <span
            className="inline-flex items-center justify-center min-w-[16px] h-[14px] px-1 rounded-full bg-primary/20 text-primary text-[9px] font-bold tabular-nums"
            title={`${tree.fileCount} file${tree.fileCount === 1 ? "" : "s"} changed`}
          >
            {tree.fileCount}
          </span>
        </span>
      </header>
      <ul className="py-1">
        {tree.children.map((child) => (
          <TreeItem
            key={child.fullPath || child.name}
            node={child}
            depth={0}
            selectedPath={selectedPath}
            onSelect={onSelect}
          />
        ))}
      </ul>
    </div>
  );
}

function TreeItem({
  node,
  depth,
  selectedPath,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  // Directories default to open. Users can collapse manually; depth
  // doesn't auto-collapse — most diffs touch a few dirs and the
  // operator wants to see all of them at once.
  const [open, setOpen] = useState(true);

  if (node.kind === "file") {
    const isSelected = node.entry.path === selectedPath;
    return (
      <li>
        <button
          type="button"
          onClick={() => onSelect(node.entry.path)}
          className={`w-full flex items-center gap-1.5 pr-2 py-[3px] text-left text-[12px] transition-colors ${
            isSelected
              ? "bg-primary/15 text-foreground"
              : "text-foreground/90 hover:bg-accent"
          }`}
          style={{ paddingLeft: `${depth * 12 + 18}px` }}
          title={node.entry.path}
        >
          <FileTypeIcon name={node.name} />
          <span className="truncate flex-1 min-w-0 font-sans">{node.name}</span>
          {(node.entry.added > 0 || node.entry.removed > 0) && (
            <span className="text-[9.5px] tabular-nums shrink-0 font-mono flex items-center gap-1 opacity-80">
              {node.entry.added > 0 && (
                <span className="text-success">+{node.entry.added}</span>
              )}
              {node.entry.removed > 0 && (
                <span className="text-destructive">-{node.entry.removed}</span>
              )}
            </span>
          )}
          <StatusBadge status={node.entry.status} />
        </button>
      </li>
    );
  }

  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-1.5 pr-2 py-[3px] text-left text-[12px] text-foreground/90 hover:bg-accent transition-colors"
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
        title={node.fullPath}
      >
        {open ? (
          <ChevronDown size={12} className="text-fg-dim shrink-0" />
        ) : (
          <ChevronRight size={12} className="text-fg-dim shrink-0" />
        )}
        {open ? (
          <FolderOpen size={13} className="text-warning shrink-0" />
        ) : (
          <Folder size={13} className="text-fg-dim shrink-0" />
        )}
        <span className="truncate flex-1 min-w-0 font-sans">{node.name || "/"}</span>
        <span className="text-[9.5px] tabular-nums shrink-0 flex items-center gap-1 font-mono opacity-80">
          {node.added > 0 && <span className="text-success">+{node.added}</span>}
          {node.removed > 0 && <span className="text-destructive">-{node.removed}</span>}
        </span>
        <span
          className="inline-flex items-center justify-center min-w-[16px] h-[14px] px-1 rounded-full bg-secondary text-fg-dim text-[9px] font-bold tabular-nums shrink-0"
          title={`${node.fileCount} file${node.fileCount === 1 ? "" : "s"}`}
        >
          {node.fileCount}
        </span>
      </button>
      {open && (
        <ul>
          {node.children.map((child) => (
            <TreeItem
              key={child.fullPath || child.name}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/* ─────────────────────────── Hunk pane ─────────────────────────── */

function colorizeLine(line: string): { cls: string; text: string } {
  if (line.startsWith("@@")) return { cls: "text-info bg-info/5", text: line };
  if (line.startsWith("+") && !line.startsWith("+++"))
    return { cls: "text-success bg-success/5", text: line };
  if (line.startsWith("-") && !line.startsWith("---"))
    return { cls: "text-destructive bg-destructive/5", text: line };
  return { cls: "text-foreground/80", text: line };
}

export function FileDiffPane({ entry }: { entry: FileDiffEntry }) {
  const statusLabel =
    entry.status === "added" ? "Added"
    : entry.status === "deleted" ? "Deleted"
    : entry.status === "renamed" ? "Renamed"
    : "Modified";
  const statusCls =
    entry.status === "added" ? "text-success"
    : entry.status === "deleted" ? "text-destructive"
    : entry.status === "renamed" ? "text-info"
    : "text-fg-dim";

  return (
    <div className="flex flex-col">
      <div className="sticky top-0 z-10 px-3 py-2 bg-background border-b border-border flex items-center gap-2 text-[11.5px] font-mono">
        <FileDiff size={12} className="text-fg-dim shrink-0" />
        {entry.oldPath && entry.status === "renamed" ? (
          <span className="truncate text-foreground">
            <span className="text-fg-dim line-through">{entry.oldPath}</span>{" "}
            <ArrowRight size={10} className="inline -mt-0.5 text-info" />{" "}
            {entry.path}
          </span>
        ) : (
          <span className="truncate text-foreground">{entry.path}</span>
        )}
        <span className={`ml-auto text-[9.5px] uppercase tracking-wide font-semibold ${statusCls}`}>
          {statusLabel}
        </span>
        {(entry.added > 0 || entry.removed > 0) && (
          <span className="text-[9.5px] tabular-nums flex items-center gap-1.5 shrink-0">
            {entry.added > 0 && <span className="text-success">+{entry.added}</span>}
            {entry.removed > 0 && <span className="text-destructive">-{entry.removed}</span>}
          </span>
        )}
      </div>
      {entry.hunks.length === 0 ? (
        <div className="p-4 text-[11.5px] text-muted-foreground italic">
          No textual hunks (file may be a pure rename, mode change, or binary).
        </div>
      ) : (
        <pre className="text-[11.5px] font-mono leading-snug">
          {entry.hunks.map((h, i) => (
            <div key={i}>
              <div className={`${colorizeLine(h.header).cls} px-3 py-0.5 border-y border-border/40`}>
                {h.header}
              </div>
              {h.lines.map((l, j) => {
                const { cls, text } = colorizeLine(l);
                return (
                  <div key={j} className={`px-3 ${cls}`}>
                    {text || " "}
                  </div>
                );
              })}
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}
