// SSE subscription helper. EventSource doesn't expose a header-setting
// API, so the bridge accepts the internal token as a `?token=` query
// parameter when the request is SSE. (When the bridge runs with
// --localhost-only the token is optional.)

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getToken, API_BASE } from "@/api/client";
import { invalidateTask, qk } from "@/api/queries";
import type { PermissionRequest } from "@/api/types";

export interface BridgeEvent {
  type?: string;
  taskId?: string;
  [key: string]: unknown;
}

/**
 * Build an absolute SSE URL with the auth token attached as `?token=`.
 * Exposed so non-hook callers (one-off subscriptions in commands /
 * imperative effects) can reuse the same composition rules.
 */
export function buildSseUrl(path: string): string {
  // window.location.origin gives the base when API_BASE is empty
  // (same-origin prod). When API_BASE is set (Vite dev proxy or a
  // separate origin) we still rely on URL's resolution to fill in the
  // origin slot.
  const origin =
    typeof window !== "undefined" ? window.location.origin : "http://localhost";
  const url = new URL(`${API_BASE}${path}`, origin);
  const tok = getToken();
  if (tok) url.searchParams.set("token", tok);
  return url.toString();
}

/**
 * Subscribe to /api/tasks/{id}/events. Any event for the task triggers
 * a meta refetch — the SSE payloads describe state transitions but we
 * always re-read meta.json so a missed frame can't desync the UI.
 */
export function useTaskEvents(taskId: string | undefined) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!taskId) return;
    const es = new EventSource(
      buildSseUrl(`/api/tasks/${encodeURIComponent(taskId)}/events`),
    );
    const onMessage = (ev: MessageEvent<string>) => {
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

/**
 * Subscribe to /api/permission/stream. Fires `permission.request` when
 * a child wants tool permission and `permission.answered` when the
 * operator clicks. The hook invalidates the matching query keys so
 * `usePermissions(...)` re-fetches automatically.
 *
 * Optional `onRequest` / `onAnswered` callbacks let UI surfaces
 * (toast / sound / desktop notification) react before the cache
 * invalidates.
 */
export function usePermissionStream(opts?: {
  onRequest?: (req: PermissionRequest) => void;
  onAnswered?: (req: PermissionRequest) => void;
}) {
  const qc = useQueryClient();
  useEffect(() => {
    const es = new EventSource(buildSseUrl("/api/permission/stream"));
    const handler =
      (kind: "request" | "answered") => (ev: MessageEvent<string>) => {
        const parsed = parseJSON<PermissionRequest>(ev.data);
        if (parsed) {
          if (kind === "request") opts?.onRequest?.(parsed);
          else opts?.onAnswered?.(parsed);
          // Invalidate both the global pending list and any
          // session-scoped variant the caller may also be reading.
          qc.invalidateQueries({ queryKey: qk.permissions });
          qc.invalidateQueries({
            queryKey: qk.sessionPermissions(parsed.sessionId),
          });
        }
      };
    const reqHandler = handler("request");
    const ansHandler = handler("answered");
    es.addEventListener("permission.request", reqHandler as EventListener);
    es.addEventListener("permission.answered", ansHandler as EventListener);
    es.addEventListener("error", () => {
      // EventSource auto-reconnects on transient errors; nothing to do.
    });
    return () => {
      es.removeEventListener("permission.request", reqHandler as EventListener);
      es.removeEventListener("permission.answered", ansHandler as EventListener);
      es.close();
    };
    // opts is intentionally not in the deps list — we expect callers
    // to pass stable refs (or accept that re-renders silently drop and
    // re-establish the stream).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qc]);
}

function parseEvent(data: string): BridgeEvent | null {
  return parseJSON<BridgeEvent>(data);
}

function parseJSON<T>(data: string): T | null {
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}
