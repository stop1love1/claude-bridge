"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronRight, ChevronDown, File, Folder, X } from "lucide-react";
import { api } from "@/libs/client/api";
import { Button } from "./ui/button";

type Entry = { name: string; type: "dir" | "file" | "other" };

type DirState =
  | { status: "loading" }
  | { status: "ok"; entries: Entry[]; truncated?: boolean }
  | { status: "error"; message: string };

function joinRel(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

function DirTree({
  rel,
  depth,
  expanded,
  cache,
  toggle,
  selectedFile,
  onFileClick,
}: {
  rel: string;
  depth: number;
  expanded: Set<string>;
  cache: Map<string, DirState>;
  toggle: (relPath: string) => void;
  selectedFile: string | null;
  onFileClick: (fileRel: string) => void;
}) {
  const state = cache.get(rel);

  if (!state || state.status === "loading") {
    return (
      <div className="py-1 text-[11px] text-muted-foreground" style={{ paddingLeft: 8 + depth * 14 }}>
        Loading…
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="py-1 text-[11px] text-destructive" style={{ paddingLeft: 8 + depth * 14 }}>
        {state.message}
      </div>
    );
  }

  const list = state.entries.filter((e) => e.type !== "other");

  return (
    <ul className="list-none m-0 p-0">
      {list.map((e) => {
        const childRel = joinRel(rel, e.name);
        const pad = 6 + depth * 14;
        if (e.type === "file") {
          const sel = selectedFile === childRel;
          return (
            <li key={childRel} style={{ paddingLeft: pad }}>
              <button
                type="button"
                onClick={() => onFileClick(childRel)}
                className={`flex w-full min-w-0 items-center gap-1.5 rounded py-0.5 pr-1 text-left text-[12px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50 ${
                  sel ? "bg-primary/12 text-foreground" : "text-foreground/90 hover:bg-accent/60"
                }`}
              >
                <File size={13} className="shrink-0 text-muted-foreground opacity-80" aria-hidden />
                <span className="font-mono truncate" title={childRel}>
                  {e.name}
                </span>
              </button>
            </li>
          );
        }
        const isOpen = expanded.has(childRel);
        return (
          <li key={childRel} className="select-none">
            <button
              type="button"
              onClick={() => toggle(childRel)}
              className="flex w-full min-w-0 items-center gap-1 rounded px-1 py-0.5 text-left text-[12px] text-foreground hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
              style={{ paddingLeft: Math.max(2, pad - 2) }}
            >
              <span className="shrink-0 text-muted-foreground w-3.5 flex justify-center" aria-hidden>
                {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              </span>
              <Folder size={13} className="shrink-0 text-primary/85" aria-hidden />
              <span className="font-mono truncate font-medium">{e.name}</span>
              <span className="text-muted-foreground/70 font-mono text-[10px]">/</span>
            </button>
            {isOpen && (
              <DirTree
                rel={childRel}
                depth={depth + 1}
                expanded={expanded}
                cache={cache}
                toggle={toggle}
                selectedFile={selectedFile}
                onFileClick={onFileClick}
              />
            )}
          </li>
        );
      })}
      {state.truncated && (
        <li className="py-1 text-[10px] text-muted-foreground italic" style={{ paddingLeft: 8 + depth * 14 }}>
          …truncated
        </li>
      )}
    </ul>
  );
}

export function AppSourceTreeTab({ appKey }: { appKey: string }) {
  const [cache, setCache] = useState<Map<string, DirState>>(() => new Map());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([""]));
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [fileBody, setFileBody] = useState<{
    path: string;
    content: string;
    truncated?: boolean;
    size?: number;
  } | null>(null);

  const loadDir = useCallback((relPath: string) => {
    setCache((prev) => {
      const next = new Map(prev);
      const cur = next.get(relPath);
      if (cur?.status === "loading" || cur?.status === "ok") return prev;
      next.set(relPath, { status: "loading" });
      return next;
    });
    void api
      .appTree(appKey, relPath)
      .then((r) => {
        setCache((prev) => {
          const next = new Map(prev);
          next.set(relPath, {
            status: "ok",
            entries: r.entries,
            truncated: r.truncated,
          });
          return next;
        });
      })
      .catch((e: Error) => {
        setCache((prev) => {
          const next = new Map(prev);
          next.set(relPath, { status: "error", message: e.message });
          return next;
        });
      });
  }, [appKey]);

  useEffect(() => {
    setCache(new Map());
    setExpanded(new Set([""]));
    setSelectedFile(null);
    setFileBody(null);
    setFileError(null);
  }, [appKey]);

  useEffect(() => {
    for (const rel of expanded) {
      const st = cache.get(rel);
      if (st?.status === "ok" || st?.status === "loading") continue;
      if (st?.status === "error") continue;
      loadDir(rel);
    }
  }, [expanded, cache, loadDir]);

  const toggle = useCallback((relPath: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(relPath)) next.delete(relPath);
      else next.add(relPath);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!selectedFile) {
      setFileBody(null);
      setFileError(null);
      setFileLoading(false);
      return;
    }
    const ac = new AbortController();
    setFileLoading(true);
    setFileError(null);
    setFileBody(null);
    void api
      .appFile(appKey, selectedFile, { signal: ac.signal })
      .then((r) => {
        if (ac.signal.aborted) return;
        setFileBody({
          path: r.path,
          content: r.content,
          truncated: r.truncated,
          size: r.size,
        });
      })
      .catch((e: Error) => {
        if (ac.signal.aborted) return;
        setFileError(e.message);
      })
      .finally(() => {
        if (!ac.signal.aborted) setFileLoading(false);
      });
    return () => ac.abort();
  }, [appKey, selectedFile]);

  const closePreview = useCallback(() => {
    setSelectedFile(null);
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col border-t border-border/60 bg-background lg:flex-row">
      <div className="flex min-h-[160px] min-w-0 flex-1 flex-col overflow-hidden border-b border-border lg:max-w-[min(420px,44%)] lg:border-b-0 lg:border-r">
        <div className="min-h-0 flex-1 overflow-auto p-2 sm:p-3">
          <DirTree
            rel=""
            depth={0}
            expanded={expanded}
            cache={cache}
            toggle={toggle}
            selectedFile={selectedFile}
            onFileClick={setSelectedFile}
          />
        </div>
      </div>

      <div className="flex min-h-[200px] min-w-0 flex-[1.15] flex-col overflow-hidden">
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-card/30 px-2 py-1.5 sm:px-3">
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] sm:text-xs text-foreground/90" title={fileBody?.path ?? selectedFile ?? ""}>
            {selectedFile ? (fileBody?.path ?? selectedFile) : "No file selected"}
          </span>
          {selectedFile && (
            <Button type="button" variant="ghost" size="iconSm" onClick={closePreview} title="Close preview" aria-label="Close preview">
              <X size={14} />
            </Button>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-auto bg-background p-2 sm:p-3">
          {selectedFile && fileLoading && (
            <p className="text-[12px] text-muted-foreground">Loading…</p>
          )}
          {selectedFile && fileError && (
            <p className="text-[12px] text-destructive font-mono whitespace-pre-wrap wrap-break-word">{fileError}</p>
          )}
          {selectedFile && fileBody && !fileLoading && !fileError && (
            <div className="space-y-2">
              {fileBody.truncated && (
                <p className="text-[10px] text-warning">
                  Preview truncated at {fileBody.content.length.toLocaleString()} characters
                  {fileBody.size !== undefined ? ` (file ${fileBody.size.toLocaleString()} bytes)` : ""}.
                </p>
              )}
              <pre className="m-0 max-w-full overflow-x-auto rounded-md border border-border bg-secondary/30 p-2 text-[11px] sm:text-xs leading-relaxed font-mono text-foreground/95 whitespace-pre-wrap wrap-break-word">
                {fileBody.content}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
