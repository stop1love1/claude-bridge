"use client";

import { useEffect, useRef } from "react";

export type EventSourceListeners = Record<string, (ev: MessageEvent) => void>;

export interface UseEventSourceOpts {
  listeners: EventSourceListeners;
  enabled?: boolean;
  onBeforeOpen?: () => Promise<void> | void;
  pauseWhenHidden?: boolean;
}

export function useEventSource(
  url: string | null,
  opts: UseEventSourceOpts,
): void {
  const { listeners, enabled = true, onBeforeOpen, pauseWhenHidden = false } = opts;
  const listenersRef = useRef(listeners);
  const onBeforeOpenRef = useRef(onBeforeOpen);
  useEffect(() => { listenersRef.current = listeners; }, [listeners]);
  useEffect(() => { onBeforeOpenRef.current = onBeforeOpen; }, [onBeforeOpen]);

  useEffect(() => {
    if (!enabled || !url) return;
    let stopped = false;
    let es: EventSource | null = null;
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
        try { es?.removeEventListener(event, w); } catch { }
      }
      wrappers.length = 0;
    };

    const open = async () => {
      if (stopped || es) return;
      try {
        await onBeforeOpenRef.current?.();
      } catch { }
      if (stopped || es) return;
      try {
        es = new EventSource(url);
      } catch {
        return;
      }
      attach();
    };

    const close = () => {
      detach();
      try { es?.close(); } catch { }
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
