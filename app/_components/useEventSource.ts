"use client";

import { useEffect, useRef } from "react";

/**
 * Map of SSE event-name → handler. Handlers receive the raw
 * `MessageEvent`; consumers parse `ev.data` themselves so the hook
 * stays agnostic about JSON shape (some streams carry plain text,
 * others carry JSON objects of varying schemas).
 */
export type EventSourceListeners = Record<string, (ev: MessageEvent) => void>;

export interface UseEventSourceOpts {
  /** Listener map: event name → handler. */
  listeners: EventSourceListeners;
  /**
   * When `false` (or `url` is `null`), no connection is opened. Toggle
   * the gate to reopen on demand without remounting the host.
   */
  enabled?: boolean;
  /**
   * Hook into the open/reopen edge — used by callers that need to
   * REST-tail any bytes the server kept while the SSE was disconnected
   * (e.g. SessionLog catches up after a `visibilitychange` reopen).
   * Awaited before the new EventSource is constructed.
   */
  onBeforeOpen?: () => Promise<void> | void;
  /**
   * When true, close the connection on `document.visibilityState ===
   * "hidden"` and reopen on visible. Saves an HTTP/1.1 SSE slot
   * (browsers cap at ~6/origin) when the tab is backgrounded.
   * Default: false.
   */
  pauseWhenHidden?: boolean;
}

/**
 * Bridge-wide hook for "open an SSE, attach listeners, clean up on
 * unmount, optionally pause when the tab is hidden."
 *
 * Consolidates the pattern that previously lived inline in
 * `SessionLog`, `tasks/[id]/page`, `AutoDetectDialog`, and
 * `usePermissionQueue` — each of which independently re-implemented
 * `new EventSource(url)` + per-event `addEventListener` + `close()` on
 * unmount, with subtly different bug profiles (one missed the
 * visibility-pause; another double-attached on rerender; another
 * leaked the connection on URL change).
 *
 * The hook ALWAYS re-resolves to the freshest listener map: handlers
 * are kept in a ref so a state-dependent listener inside a parent
 * component doesn't get stale-captured by the EventSource constructor
 * call. The actual listener wiring happens once per `(url, enabled,
 * pauseWhenHidden)` change — adding a new event name in a re-render
 * does NOT register it (the listener map shape is treated as stable
 * for the lifetime of the connection).
 */
export function useEventSource(
  url: string | null,
  opts: UseEventSourceOpts,
): void {
  const { listeners, enabled = true, onBeforeOpen, pauseWhenHidden = false } = opts;
  const listenersRef = useRef(listeners);
  const onBeforeOpenRef = useRef(onBeforeOpen);
  // Refresh the refs on every render so a state-bound handler still
  // sees current props/state when the EventSource fires.
  useEffect(() => { listenersRef.current = listeners; }, [listeners]);
  useEffect(() => { onBeforeOpenRef.current = onBeforeOpen; }, [onBeforeOpen]);

  useEffect(() => {
    if (!enabled || !url) return;
    let stopped = false;
    let es: EventSource | null = null;
    // Stable wrappers that read the latest handler off the ref. We
    // attach these to EventSource ONCE per open() call; switching
    // the listener map on the parent's next render is a no-op for an
    // existing connection (matches React's mount-effect semantics).
    const wrappers: Array<[string, EventListener]> = [];

    const attach = () => {
      const ls = listenersRef.current;
      for (const event of Object.keys(ls)) {
        const w: EventListener = (ev) => {
          listenersRef.current[event]?.(ev as MessageEvent);
        };
        es?.addEventListener(event, w);
        wrappers.push([event, w]);
      }
    };

    const detach = () => {
      for (const [event, w] of wrappers) {
        try { es?.removeEventListener(event, w); } catch { /* ignore */ }
      }
      wrappers.length = 0;
    };

    const open = async () => {
      if (stopped || es) return;
      try {
        await onBeforeOpenRef.current?.();
      } catch { /* caller-supplied; never block stream open on its failure */ }
      if (stopped || es) return;
      try {
        es = new EventSource(url);
      } catch {
        // Some browsers throw synchronously on malformed URL; treat
        // as "no stream available" and stay quiet — the caller's
        // polling fallback (if any) will handle the gap.
        return;
      }
      attach();
    };

    const close = () => {
      detach();
      try { es?.close(); } catch { /* ignore */ }
      es = null;
    };

    const onVisibilityChange = () => {
      if (typeof document === "undefined") return;
      if (document.visibilityState === "hidden") {
        close();
      } else {
        void open();
      }
    };

    if (pauseWhenHidden && typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }
    void open();

    return () => {
      stopped = true;
      close();
      if (pauseWhenHidden && typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
    };
  }, [url, enabled, pauseWhenHidden]);
}
