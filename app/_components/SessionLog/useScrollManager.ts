"use client";


import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { asBlocks, classify, extractAttachments, stripSystemTags, type LogEntry } from "./helpers";

export function useScrollManager(
  entries: LogEntry[],
  visibleEntries: LogEntry[],
  logRef: React.RefObject<HTMLDivElement | null>,
  pendingScrollRestoreRef: React.RefObject<{ prevHeight: number; prevTop: number } | null>,
  firstOffsetRef: React.RefObject<number | null>,
  inFlightOlderRef: React.RefObject<boolean>,
  loadOlder: () => void | Promise<void>,
) {
  const [autoScroll, setAutoScroll] = useState(true);
  const [pinnedUserUuid, setPinnedUserUuid] = useState<string | null>(null);

  const userTextOf = useCallback((e: LogEntry): string => {
    const blocks = asBlocks(e.message?.content);
    const raw = blocks
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text!)
      .join(" ");
    const { stripped } = extractAttachments(raw);
    const cleaned = stripSystemTags(stripped);
    return cleaned.trim() || stripped.trim() || raw.trim();
  }, []);

  const lastUserText = useMemo(() => {
    for (let i = visibleEntries.length - 1; i >= 0; i--) {
      const e = visibleEntries[i];
      if (classify(e) !== "user") continue;
      const text = userTextOf(e);
      if (text) return text;
    }
    return "";
  }, [visibleEntries, userTextOf]);

  const pinnedUserText = useMemo(() => {
    if (autoScroll || !pinnedUserUuid) return lastUserText;
    for (const e of visibleEntries) {
      if (e.uuid !== pinnedUserUuid) continue;
      if (classify(e) !== "user") continue;
      const text = userTextOf(e);
      if (text) return text;
      break;
    }
    return lastUserText;
  }, [autoScroll, pinnedUserUuid, visibleEntries, lastUserText, userTextOf]);

  useLayoutEffect(() => {
    const restore = pendingScrollRestoreRef.current;
    if (!restore) return;
    const el = logRef.current;
    if (!el) {
      pendingScrollRestoreRef.current = null;
      return;
    }
    el.scrollTop = el.scrollHeight - restore.prevHeight + restore.prevTop;
    pendingScrollRestoreRef.current = null;
  }, [entries, logRef, pendingScrollRestoreRef]);

  useEffect(() => {
    if (!autoScroll) return;
    if (pendingScrollRestoreRef.current) return;
    requestAnimationFrame(() => {
      if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    });
  }, [visibleEntries, autoScroll, logRef, pendingScrollRestoreRef]);

  const autoScrollRef = useRef(autoScroll);
  useEffect(() => {
    autoScrollRef.current = autoScroll;
  }, [autoScroll]);
  useEffect(() => {
    const el = logRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (!autoScrollRef.current) return;
      if (pendingScrollRestoreRef.current) return;
      el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [logRef, pendingScrollRestoreRef]);

  const recomputePinnedUuid = useCallback(() => {
    const el = logRef.current;
    if (!el) return;
    const containerTop = el.getBoundingClientRect().top;
    const threshold = containerTop + 4;
    const rows = el.querySelectorAll<HTMLDivElement>("[data-user-uuid]");
    let pickUuid: string | null = null;
    for (const row of rows) {
      const r = row.getBoundingClientRect();
      if (r.bottom <= threshold) {
        const uuid = row.getAttribute("data-user-uuid") || "";
        if (uuid) pickUuid = uuid;
      } else {
        break;
      }
    }
    setPinnedUserUuid((prev) => (prev === pickUuid ? prev : pickUuid));
  }, [logRef]);

  const rafScheduledRef = useRef(false);
  const schedulePinnedRecalc = useCallback(() => {
    if (rafScheduledRef.current) return;
    rafScheduledRef.current = true;
    requestAnimationFrame(() => {
      rafScheduledRef.current = false;
      recomputePinnedUuid();
    });
  }, [recomputePinnedUuid]);

  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const rows = el.querySelectorAll<HTMLDivElement>("[data-user-uuid]");
    if (rows.length === 0) return;
    const io = new IntersectionObserver(
      () => schedulePinnedRecalc(),
      { root: el, threshold: [0, 1] },
    );
    rows.forEach((r) => io.observe(r));
    schedulePinnedRecalc();
    return () => io.disconnect();
  }, [visibleEntries, schedulePinnedRecalc, logRef]);

  const handleScroll = useCallback(() => {
    const el = logRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(atBottom);
    if (
      el.scrollTop < 32 &&
      firstOffsetRef.current !== null &&
      firstOffsetRef.current > 0 &&
      !inFlightOlderRef.current
    ) {
      void loadOlder();
    }
    schedulePinnedRecalc();
  }, [loadOlder, schedulePinnedRecalc, logRef, firstOffsetRef, inFlightOlderRef]);

  const scrollToBottom = useCallback(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    setAutoScroll(true);
  }, [logRef]);

  return {
    autoScroll,
    setAutoScroll,
    scrollToBottom,
    pinnedUserUuid,
    setPinnedUserUuid,
    pinnedUserText,
    handleScroll,
  };
}
