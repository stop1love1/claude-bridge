"use client";


import { startTransition, useCallback, useEffect, useState } from "react";
import { api } from "@/libs/client/api";
import { MAX_RENDERED, pruneOptimistic, type ActiveRun, type LogEntry } from "./helpers";
import { appendPartial, clearPartials, dropOnArrival } from "./partialsStore";

export function useSessionStream(
  run: ActiveRun | null,
  logRef: React.RefObject<HTMLDivElement | null>,
  offsetRef: React.RefObject<number>,
  firstOffsetRef: React.RefObject<number | null>,
  entryOffsetsRef: React.RefObject<number[]>,
  loadedOlderCountRef: React.RefObject<number>,
  inFlightOlderRef: React.RefObject<boolean>,
  pendingScrollRestoreRef: React.RefObject<{ prevHeight: number; prevTop: number } | null>,
) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [trimmed, setTrimmed] = useState(0);
  const [lastTs, setLastTs] = useState<number>(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [aliveSse, setAliveSse] = useState<boolean | null>(null);
  const [activity, setActivity] = useState<{
    kind: "thinking" | "running" | "idle";
    label?: string;
  }>({ kind: "idle" });

  useEffect(() => {
    if (!run) return;

    let stopped = false;
    let es: EventSource | null = null;
    let aliveSweepTimer: ReturnType<typeof setTimeout> | null = null;

    const applyTail = (payload: {
      lines: unknown[];
      offset: number;
      lineOffsets: number[] | undefined;
    }) => {
      offsetRef.current = payload.offset;
      if (!payload.lines.length) return;
      const lines = payload.lines as LogEntry[];
      const newest = lines[lines.length - 1]?.timestamp;
      if (newest) setLastTs(new Date(newest).getTime());
      const newLineOffsets = Array.isArray(payload.lineOffsets) ? payload.lineOffsets : [];
      const arrivedAssistant = lines.some((l) => l?.type === "assistant");
      if (arrivedAssistant) {
        const arrivedIds: string[] = [];
        for (const l of lines) {
          const id = l?.message?.id;
          if (typeof id === "string") arrivedIds.push(id);
        }
        dropOnArrival(run.sessionId, arrivedIds);
      }
      startTransition(() => {
        setEntries((prev) => {
          const baseline = pruneOptimistic(prev, lines);
          const seen = new Set<string>();
          for (const e of baseline) {
            if (e.uuid) seen.add(e.uuid);
          }
          const dedupLines: LogEntry[] = [];
          const dedupOffsets: number[] = [];
          for (let i = 0; i < lines.length; i++) {
            const l = lines[i];
            const id = l?.uuid;
            if (id && seen.has(id)) continue;
            if (id) seen.add(id);
            dedupLines.push(l);
            dedupOffsets.push(newLineOffsets[i] ?? 0);
          }
          if (dedupLines.length === 0 && baseline.length === prev.length) return prev;

          const merged = [...baseline, ...dedupLines];
          const mergedOffsets = [
            ...entryOffsetsRef.current,
            ...dedupOffsets,
          ];
          const protectedFront = loadedOlderCountRef.current;
          const trimWindow = merged.length - protectedFront;
          if (trimWindow <= MAX_RENDERED) {
            entryOffsetsRef.current = mergedOffsets;
            if (firstOffsetRef.current === null) {
              firstOffsetRef.current = mergedOffsets[0] ?? 0;
            }
            return merged;
          }
          const drop = trimWindow - MAX_RENDERED;
          setTrimmed((t) => t + drop);
          const keptOffsets = [
            ...mergedOffsets.slice(0, protectedFront),
            ...mergedOffsets.slice(protectedFront + drop),
          ];
          entryOffsetsRef.current = keptOffsets;
          if (firstOffsetRef.current === null) {
            firstOffsetRef.current = keptOffsets[0] ?? 0;
          }
          return [
            ...merged.slice(0, protectedFront),
            ...merged.slice(protectedFront + drop),
          ];
        });
      });
    };

    const openStream = () => {
      if (stopped || es) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      const url = `/api/sessions/${encodeURIComponent(run.sessionId)}/tail/stream?repo=${encodeURIComponent(run.repoPath)}&since=${offsetRef.current}`;
      try {
        es = new EventSource(url);
      } catch {
        return;
      }
      es.addEventListener("tail", (ev) => {
        if (stopped) return;
        try {
          const payload = JSON.parse((ev as MessageEvent).data);
          applyTail(payload);
        } catch { }
      });
      es.addEventListener("partial", (ev) => {
        if (stopped) return;
        try {
          const p = JSON.parse((ev as MessageEvent).data) as {
            messageId: string;
            index: number;
            text: string;
          };
          if (!p?.text) return;
          appendPartial(run.sessionId, p.messageId, p.text);
          setLastTs(Date.now());
        } catch { }
      });
      es.addEventListener("alive", (ev) => {
        if (stopped) return;
        try {
          const { alive } = JSON.parse((ev as MessageEvent).data) as { alive: boolean };
          setAliveSse(alive);
          if (!alive) {
            setActivity({ kind: "idle" });
            if (aliveSweepTimer) clearTimeout(aliveSweepTimer);
            aliveSweepTimer = setTimeout(() => {
              aliveSweepTimer = null;
              if (stopped) return;
              clearPartials(run.sessionId);
            }, 2000);
          }
        } catch { }
      });
      es.addEventListener("status", (ev) => {
        if (stopped) return;
        try {
          const s = JSON.parse((ev as MessageEvent).data) as {
            kind: "thinking" | "running" | "idle";
            label?: string;
          };
          if (s && (s.kind === "thinking" || s.kind === "running" || s.kind === "idle")) {
            setActivity({ kind: s.kind, label: s.label });
          }
        } catch { }
      });
    };

    const closeStream = () => {
      try { es?.close(); } catch { }
      es = null;
    };

    const onVis = () => {
      if (typeof document === "undefined") return;
      if (document.visibilityState === "hidden") {
        closeStream();
      } else {
        api.tail(run.sessionId, run.repoPath, offsetRef.current)
          .then((payload) => { if (!stopped) applyTail(payload); })
          .catch(() => { })
          .finally(() => openStream());
      }
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVis);
    }

    openStream();
    return () => {
      stopped = true;
      if (aliveSweepTimer) {
        clearTimeout(aliveSweepTimer);
        aliveSweepTimer = null;
      }
      closeStream();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVis);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.sessionId, run?.repoPath]);

  const loadOlder = useCallback(async () => {
    if (!run) return;
    if (inFlightOlderRef.current) return;
    const cur = firstOffsetRef.current;
    if (cur === null || cur <= 0) return;
    const el = logRef.current;
    if (!el) return;
    inFlightOlderRef.current = true;
    setLoadingOlder(true);
    pendingScrollRestoreRef.current = {
      prevHeight: el.scrollHeight,
      prevTop: el.scrollTop,
    };
    try {
      const result = await api.tailBefore(run.sessionId, run.repoPath, cur);
      const olderLines = (result.lines ?? []) as LogEntry[];
      const olderOffsets = Array.isArray(result.lineOffsets) ? result.lineOffsets : [];
      if (olderLines.length === 0) {
        firstOffsetRef.current = result.fromOffset === 0 ? 0 : cur;
        pendingScrollRestoreRef.current = null;
        return;
      }
      const seen = new Set<string>();
      for (const e of entries) {
        if (e.uuid) seen.add(e.uuid);
      }
      const dedupOlder: LogEntry[] = [];
      const dedupOlderOffsets: number[] = [];
      for (let i = 0; i < olderLines.length; i++) {
        const l = olderLines[i];
        const id = l?.uuid;
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        dedupOlder.push(l);
        dedupOlderOffsets.push(olderOffsets[i] ?? 0);
      }
      setEntries((prev) => [...dedupOlder, ...prev]);
      entryOffsetsRef.current = [...dedupOlderOffsets, ...entryOffsetsRef.current];
      loadedOlderCountRef.current += dedupOlder.length;
      firstOffsetRef.current = result.fromOffset;
      if (dedupOlder.length > 0) {
        setTrimmed((t) => Math.max(0, t - dedupOlder.length));
      }
    } catch {
      pendingScrollRestoreRef.current = null;
    } finally {
      inFlightOlderRef.current = false;
      setLoadingOlder(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run]);

  return {
    entries,
    setEntries,
    trimmed,
    setTrimmed,
    activity,
    aliveSse,
    lastTs,
    loadOlder,
    loadingOlder,
  };
}
