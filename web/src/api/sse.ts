// SSE subscription helper. EventSource doesn't expose a header-setting
// API, so the bridge accepts the internal token as a `?token=` query
// parameter when the request is SSE. (When the bridge runs with
// --localhost-only the token is optional.)

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getToken, API_BASE } from "@/api/client";
import { invalidateTask } from "@/api/queries";

interface BridgeEvent {
  type?: string;
  taskId?: string;
  [key: string]: unknown;
}

export function useTaskEvents(taskId: string | undefined) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!taskId) return;
    const url = new URL(
      `${API_BASE}/api/tasks/${encodeURIComponent(taskId)}/events`,
      window.location.origin,
    );
    const tok = getToken();
    if (tok) url.searchParams.set("token", tok);

    const es = new EventSource(url.toString());
    const onMessage = (ev: MessageEvent<string>) => {
      // Any event for the task means meta may have shifted — let
      // react-query refetch rather than trying to merge in place.
      void parseEvent(ev.data);
      invalidateTask(qc, taskId);
    };
    es.addEventListener("message", onMessage);
    es.addEventListener("task.event", onMessage as EventListener);
    es.addEventListener("agent.detect.progress", onMessage as EventListener);
    es.addEventListener("error", () => {
      // Browser auto-reconnects; nothing to do beyond logging.
    });
    return () => {
      es.removeEventListener("message", onMessage);
      es.close();
    };
  }, [taskId, qc]);
}

function parseEvent(data: string): BridgeEvent | null {
  try {
    return JSON.parse(data) as BridgeEvent;
  } catch {
    return null;
  }
}
