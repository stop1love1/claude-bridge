"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { Highlight, themes, type Language } from "prism-react-renderer";
import { FileText } from "lucide-react";
import { api } from "@/libs/client/api";
import { cn } from "@/libs/cn";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import { CopyButton } from "../ui/copy-button";
import { parseFileRef, type FileRef } from "./fileRef";

/**
 * The repo a transcript belongs to. A module-level markdown component map
 * cannot be given props, so the anchor reads the repo from here instead of
 * rebuilding the map on every render.
 */
const FileRefRepoContext = createContext<string | undefined>(undefined);

export function FileRefRepoProvider({
  repo,
  children,
}: {
  repo?: string;
  children: React.ReactNode;
}) {
  return (
    <FileRefRepoContext.Provider value={repo}>{children}</FileRefRepoContext.Provider>
  );
}

const EXT_LANG: Record<string, Language> = {
  ts: "tsx", tsx: "tsx", mts: "tsx", cts: "tsx",
  js: "jsx", jsx: "jsx", mjs: "jsx", cjs: "jsx",
  json: "json", py: "python", sh: "bash", bash: "bash",
  yml: "yaml", yaml: "yaml", md: "markdown",
  html: "markup", xml: "markup", svg: "markup",
  css: "css", scss: "css", sql: "sql",
  go: "go", rs: "rust", java: "java",
};

function langFor(path: string): Language {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return EXT_LANG[ext] ?? ("tsx" as Language);
}

function FileViewer({
  repo,
  target,
  onClose,
}: {
  repo: string;
  target: FileRef;
  onClose: () => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const lineRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    api
      .repoFile(repo, target.path, { signal: ac.signal })
      .then((r) => {
        setContent(r.content);
        setTruncated(!!r.truncated);
      })
      .catch((e: unknown) => {
        if (ac.signal.aborted) return;
        setError((e as Error)?.message ?? "could not read the file");
      });
    return () => ac.abort();
  }, [repo, target.path]);

  useEffect(() => {
    if (content === null) return;
    lineRef.current?.scrollIntoView({ block: "center" });
  }, [content]);


  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-[min(92vw,900px)]">
        <DialogTitle className="flex items-center gap-2 text-[13px] font-mono break-all">
          <FileText size={13} className="text-primary shrink-0" />
          <span className="min-w-0 truncate">{target.path}</span>
          {target.line && (
            <span className="text-muted-foreground shrink-0">:{target.line}</span>
          )}
          <span className="flex-1" />
          {content !== null && (
            <CopyButton value={content} label="Copy file" className="shrink-0" />
          )}
        </DialogTitle>

        {error !== null ? (
          <p className="text-[12px] text-warning">
            {error.includes("404") ? "File not found in this repo." : error}
          </p>
        ) : content === null ? (
          <p className="text-[12px] text-muted-foreground italic">Reading file…</p>
        ) : (
          <div className="max-h-[70vh] overflow-auto rounded-md border border-border bg-[#1e1e1e]">
            <Highlight code={content} language={langFor(target.path)} theme={themes.vsDark}>
              {({ tokens, getLineProps, getTokenProps }) => (
                <pre className="m-0 p-2 text-[11.5px] leading-relaxed" style={{ margin: 0 }}>
                  {tokens.map((line, i) => {
                    const n = i + 1;
                    const hit = target.line === n;
                    const lineProps = getLineProps({ line });
                    return (
                      <div
                        key={n}
                        ref={hit ? lineRef : undefined}
                        className={cn(
                          "flex gap-3 px-1",
                          hit && "bg-primary/25 rounded-sm",
                        )}
                      >
                        <span className="select-none text-right w-10 shrink-0 text-fg-dim tabular-nums">
                          {n}
                        </span>
                        <span {...lineProps} className="whitespace-pre-wrap wrap-break-word">
                          {line.map((token, k) => (
                            <span key={k} {...getTokenProps({ token })} />
                          ))}
                        </span>
                      </div>
                    );
                  })}
                </pre>
              )}
            </Highlight>
          </div>
        )}
        {truncated && (
          <p className="text-[11px] text-muted-foreground">
            Showing the first part of the file — it was truncated by the server.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Renders a repo-relative file reference as something that actually opens.
 * Falls back to plain text when there is no repo to resolve it against, so a
 * dead reference never looks clickable.
 */
export function FileRefLink({
  target,
  children,
}: {
  target: FileRef;
  children: React.ReactNode;
}) {
  const repo = useContext(FileRefRepoContext);
  const [open, setOpen] = useState(false);

  if (!repo) return <span className="font-mono">{children}</span>;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-primary hover:underline underline-offset-2"
        title={`Open ${target.path}${target.line ? `:${target.line}` : ""}`}
      >
        {children}
      </button>
      {open && (
        <FileViewer repo={repo} target={target} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

export { parseFileRef };
