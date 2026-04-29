"use client";

import { useEffect, useRef, useState } from "react";
import { FileSearch, FileText } from "lucide-react";
import { api } from "@/libs/client/api";

export interface MentionMatch { rel: string; path: string }

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

  // Flip `loading` to true synchronously during render whenever the
  // (repo, query) tuple changes — the React-docs "previous-render
  // snapshot" pattern. That keeps `loading` consistent with the
  // about-to-fire fetch *without* a `setLoading(true)` call inside
  // the effect body (which the React 19 hooks linter flags).
  const [prevDeps, setPrevDeps] = useState({ repo, query });
  if (prevDeps.repo !== repo || prevDeps.query !== query) {
    setPrevDeps({ repo, query });
    setLoading(true);
  }

  useEffect(() => {
    if (!repo) return;
    const id = ++reqRef.current;
    api.files(repo, query)
      .then((r) => {
        if (id !== reqRef.current) return;
        setMatches(r);
        setCursor(0);
        setLoading(false);
      })
      .catch(() => {
        if (id !== reqRef.current) return;
        setMatches([]);
        setLoading(false);
      });
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
    <div className="absolute bottom-full mb-2 left-0 right-0 max-w-md bg-card border border-border rounded-lg shadow-2xl z-40 overflow-hidden animate-slide-in">
      <div className="px-3 py-1.5 border-b border-border flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
        <FileSearch size={11} />
        Mention file in <span className="font-mono normal-case text-foreground">{repo}</span>
        {query && <span className="ml-auto font-mono normal-case text-fg-dim">@{query}</span>}
      </div>
      <ul className="max-h-60 overflow-y-auto py-1">
        {loading && matches.length === 0 ? (
          <li className="px-3 py-2 text-xs text-fg-dim italic">Scanning…</li>
        ) : matches.length === 0 ? (
          <li className="px-3 py-2 text-xs text-fg-dim italic">No matching files</li>
        ) : (
          matches.map((m, i) => (
            <li key={m.path}>
              <button
                type="button"
                onMouseEnter={() => setCursor(i)}
                onMouseDown={(e) => { e.preventDefault(); onPick(m); }}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-left ${
                  i === cursor ? "bg-accent" : ""
                }`}
              >
                <FileText size={11} className="text-fg-dim shrink-0" />
                <span className="text-xs font-mono truncate">{m.rel}</span>
              </button>
            </li>
          ))
        )}
      </ul>
      <div className="px-3 py-1 border-t border-border bg-secondary text-[10px] text-fg-dim">
        ↑↓ move · ↵/Tab select · Esc cancel
      </div>
    </div>
  );
}
