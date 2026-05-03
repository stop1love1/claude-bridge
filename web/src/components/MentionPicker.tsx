import { useEffect, useRef, useState } from "react";
import { FileSearch, FileText } from "lucide-react";
import { api } from "@/api/client";
import type { RepoFileEntry } from "@/api/types";
import { cn } from "@/lib/cn";

export interface MentionMatch {
  /** Path relative to the repo root — what we insert as `@<rel>`. */
  rel: string;
  /** Absolute path returned by the bridge (used for de-duplication). */
  path: string;
}

/**
 * Floating @-mention picker. Anchors above the composer textarea
 * (caller positions us via `bottom-full`). Loads matching files from
 * the repo with a 150 ms debounce.
 *
 * Keyboard: ↑↓ to move, Enter/Tab to insert, Esc to dismiss. The
 * keydown listener is attached at the document level (capture phase)
 * so it runs before the textarea's own onKeyDown.
 */
export function MentionPicker({
  repo,
  query,
  onPick,
  onClose,
}: {
  repo: string;
  query: string;
  onPick: (m: MentionMatch) => void;
  onClose: () => void;
}) {
  const [matches, setMatches] = useState<MentionMatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [cursor, setCursor] = useState(0);
  const reqRef = useRef(0);

  // Mark loading immediately when (repo, query) changes — keeps the
  // skeleton state in sync without a setState-inside-effect.
  const [prevDeps, setPrevDeps] = useState({ repo, query });
  if (prevDeps.repo !== repo || prevDeps.query !== query) {
    setPrevDeps({ repo, query });
    setLoading(true);
  }

  useEffect(() => {
    if (!repo) return;
    const id = ++reqRef.current;
    const ac = new AbortController();
    const handle = setTimeout(() => {
      api.repos
        .files(repo, query || undefined, { signal: ac.signal })
        .then((r) => {
          if (id !== reqRef.current) return;
          // The repo files endpoint returns shallow listings keyed by
          // entry name. Map onto the MentionMatch shape with `rel` set
          // to the entry name (the API doesn't currently emit a true
          // recursive search; q just narrows the listed dir). When the
          // backend grows fuzzy search this becomes a no-op upgrade.
          const entries = (r.entries ?? []).filter((e) => e.type === "file");
          setMatches(
            entries.slice(0, 30).map((e: RepoFileEntry) => ({
              rel: e.name,
              path: e.name,
            })),
          );
          setCursor(0);
          setLoading(false);
        })
        .catch(() => {
          if (id !== reqRef.current || ac.signal.aborted) return;
          setMatches([]);
          setLoading(false);
        });
    }, 150);
    return () => {
      clearTimeout(handle);
      ac.abort();
    };
  }, [repo, query]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setCursor((c) => Math.min(matches.length - 1, c + 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setCursor((c) => Math.max(0, c - 1));
      } else if (e.key === "Enter" || e.key === "Tab") {
        if (matches[cursor]) {
          e.preventDefault();
          onPick(matches[cursor]);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [matches, cursor, onPick, onClose]);

  return (
    <div className="absolute bottom-full mb-2 left-0 right-0 max-w-md bg-surface border border-border rounded-md shadow-2xl z-40 overflow-hidden animate-fade-up">
      <div className="px-3 py-1.5 border-b border-border flex items-center gap-2 text-micro uppercase tracking-wideish text-muted">
        <FileSearch size={11} />
        Mention file in{" "}
        <span className="font-mono normal-case text-fg">{repo}</span>
        {query && (
          <span className="ml-auto font-mono normal-case text-muted">
            @{query}
          </span>
        )}
      </div>
      <ul className="max-h-60 overflow-y-auto py-1">
        {loading && matches.length === 0 ? (
          <li className="px-3 py-2 text-xs text-muted italic">Scanning…</li>
        ) : matches.length === 0 ? (
          <li className="px-3 py-2 text-xs text-muted italic">
            No matching files
          </li>
        ) : (
          matches.map((m, i) => (
            <li key={m.path}>
              <button
                type="button"
                onMouseEnter={() => setCursor(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onPick(m);
                }}
                className={cn(
                  "w-full flex items-center gap-2 px-3 py-1.5 text-left",
                  i === cursor ? "bg-surface-2" : "",
                )}
              >
                <FileText size={11} className="text-muted shrink-0" />
                <span className="text-xs font-mono truncate">{m.rel}</span>
              </button>
            </li>
          ))
        )}
      </ul>
      <div className="px-3 py-1 border-t border-border bg-surface-2 text-[10px] text-muted">
        ↑↓ move · ↵/Tab select · Esc cancel
      </div>
    </div>
  );
}
