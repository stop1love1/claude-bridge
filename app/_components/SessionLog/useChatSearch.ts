"use client";


import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LogEntry } from "./helpers";

export function useChatSearch(
  visibleEntries: LogEntry[],
  logRef: React.RefObject<HTMLDivElement | null>,
) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [matchIdx, setMatchIdx] = useState(0);
  const [matchSeed, setMatchSeed] = useState(searchQuery);
  if (matchSeed !== searchQuery) {
    setMatchSeed(searchQuery);
    setMatchIdx(0);
  }
  const searchInputRef = useRef<HTMLInputElement>(null);

  const entryKey = useCallback((e: LogEntry, fallback: number): string => {
    return (
      e.uuid ||
      e.message?.id ||
      (e.timestamp ? `${e.timestamp}:${e.type ?? ""}` : `pos-${fallback}`)
    );
  }, []);

  const searchIndex = useMemo(
    () =>
      visibleEntries.map((e, i) => {
        const c = e.message?.content;
        const text = typeof c === "string" ? c : JSON.stringify(c ?? "");
        return { key: entryKey(e, i), text: text.toLowerCase() };
      }),
    [visibleEntries, entryKey],
  );

  const matchedKeys = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [] as string[];
    const keys: string[] = [];
    for (const item of searchIndex) {
      if (item.text.includes(q)) keys.push(item.key);
    }
    return keys;
  }, [searchQuery, searchIndex]);

  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
  }, []);
  const scrollToMatch = useCallback((idx: number) => {
    const k = matchedKeys[idx];
    if (!k) return;
    const sel = `[data-entry-key="${(typeof CSS !== "undefined" && CSS.escape ? CSS.escape(k) : k)}"]`;
    const el = logRef.current?.querySelector(sel) as HTMLElement | null;
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("ring-2", "ring-warning/60");
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = setTimeout(() => {
      el.classList.remove("ring-2", "ring-warning/60");
      highlightTimerRef.current = null;
    }, 1400);
  }, [matchedKeys, logRef]);

  useEffect(() => {
    if (!searchOpen) return;
    if (matchedKeys.length === 0) return;
    scrollToMatch(matchIdx);
  }, [matchIdx, matchedKeys, scrollToMatch, searchOpen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "f") {
        if (!logRef.current) return;
        const r = logRef.current.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return;
        e.preventDefault();
        setSearchOpen(true);
        setTimeout(() => searchInputRef.current?.focus(), 0);
      }
      if (e.key === "Escape" && searchOpen) {
        setSearchOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [searchOpen, logRef]);

  const open = useCallback(() => {
    setSearchOpen(true);
    setTimeout(() => searchInputRef.current?.focus(), 0);
  }, []);

  const close = useCallback(() => {
    setSearchOpen(false);
  }, []);

  const next = useCallback(() => {
    if (matchedKeys.length === 0) return;
    setMatchIdx((i) => (i + 1) % matchedKeys.length);
  }, [matchedKeys]);

  const prev = useCallback(() => {
    if (matchedKeys.length === 0) return;
    setMatchIdx((i) => (i - 1 + matchedKeys.length) % matchedKeys.length);
  }, [matchedKeys]);

  return {
    searchOpen,
    searchQuery,
    matchIdx,
    searchIndex,
    matchedKeys,
    setSearchQuery,
    searchInputRef,
    open,
    next,
    prev,
    close,
  };
}
