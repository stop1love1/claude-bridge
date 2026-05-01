"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/libs/client/api";

/**
 * Shared client-side state machine for the three PreToolUse permission
 * dialog surfaces (`PermissionDialog`, `InlinePermissionRequests`,
 * `GlobalPermissionDialog`). Before this hook each one carried its own
 * ~120 lines of identical queue / SSE / answer plumbing — different
 * enough to subtly diverge (the global dialog never fetched backlog,
 * two of them duplicated SSE subscriptions for the same session and
 * raced each other's POST). One source of truth, three thin UIs.
 *
 * Scope decides where the events come from:
 *   - `{ sessionId }`     — per-session backlog GET + SSE
 *   - `{ all: true }`     — cross-session backlog GET + SSE
 *
 * The "remember for this session" memo is keyed on `${sessionId}:${tool}`
 * for both scopes so a remembered allow on session A never auto-resolves
 * the same tool name on session B.
 *
 * Cross-scope deduplication: when a session-scoped consumer mounts it
 * registers itself in `globalThis.__bridgeActivePermSessions`, and the
 * `{ all: true }` consumer skips events for any session in that set so
 * we never render two dialogs for the same request.
 */

export interface PendingRequest {
  /** Session that triggered the tool call. Always present for both scopes. */
  sessionId: string;
  requestId: string;
  tool: string;
  input: unknown;
  createdAt?: string;
}

export type Scope = { sessionId: string; all?: false } | { all: true; sessionId?: undefined };

interface ActiveSessionRegistry {
  add(sessionId: string): void;
  remove(sessionId: string): void;
  has(sessionId: string): boolean;
}

/**
 * Shared registry on `globalThis` so the cross-session consumer can
 * skip events for sessions that already have a session-scoped consumer
 * mounted. Counted refs so two simultaneous session-scoped subscribers
 * (rare but possible — e.g. PermissionDialog + InlinePermissionRequests
 * both mounted for the same session) only flip back to "absent" when
 * the LAST one unmounts.
 */
function getActiveSessionRegistry(): ActiveSessionRegistry {
  type G = { __bridgeActivePermSessions?: Map<string, number> };
  const g = globalThis as unknown as G;
  if (!g.__bridgeActivePermSessions) g.__bridgeActivePermSessions = new Map();
  const map = g.__bridgeActivePermSessions;
  return {
    add(id) {
      map.set(id, (map.get(id) ?? 0) + 1);
    },
    remove(id) {
      const cur = map.get(id) ?? 0;
      if (cur <= 1) map.delete(id);
      else map.set(id, cur - 1);
    },
    has(id) {
      return (map.get(id) ?? 0) > 0;
    },
  };
}

/**
 * Pure-function event merge. Exported for unit testing — the hook
 * delegates to it for every incoming `pending` / `answered` event so
 * the merge semantics can be exercised without React.
 *
 * Rules:
 *   - `pending`  : append if not already in the queue (de-dupe on requestId).
 *   - `answered` : drop the matching requestId from the queue (any tab
 *                  may have answered).
 *   - For the `{ all: true }` consumer the caller is responsible for
 *     dropping events whose sessionId is in the active registry BEFORE
 *     calling this — keeps the function pure.
 */
export function reduceQueue(
  prev: PendingRequest[],
  evt:
    | { kind: "pending"; req: PendingRequest }
    | { kind: "answered"; requestId: string },
): PendingRequest[] {
  if (evt.kind === "pending") {
    if (prev.some((r) => r.requestId === evt.req.requestId)) return prev;
    return [...prev, evt.req];
  }
  // answered
  if (!prev.some((r) => r.requestId === evt.requestId)) return prev;
  return prev.filter((r) => r.requestId !== evt.requestId);
}

export interface UsePermissionQueueResult {
  /** FIFO of pending requests the UI should surface. */
  queue: PendingRequest[];
  /** POST allow / deny for a specific request. */
  respond: (req: PendingRequest, decision: "allow" | "deny") => Promise<void>;
  /**
   * Convenience for the common "answer + maybe remember + drop from queue"
   * flow used by every dialog. `remember=true` memoises the decision keyed
   * on (sessionId, tool) so the next matching request is auto-resolved
   * without showing the dialog.
   */
  answer: (req: PendingRequest, decision: "allow" | "deny", remember: boolean) => Promise<void>;
}

interface BacklogResponse { pending?: PendingRequest[] }

/**
 * Runtime shape guard for events arriving over SSE / backlog GET. The
 * server is in our own tree, but a version mismatch between a long-
 * lived dashboard tab and a freshly-deployed bridge could otherwise
 * inject `{ requestId: undefined, tool: undefined }` into the queue
 * and surface a permission card that says "execute undefined". The
 * guard rejects anything missing the load-bearing string fields.
 */
function isValidPendingRequest(x: unknown): x is PendingRequest {
  if (!x || typeof x !== "object") return false;
  const r = x as Partial<PendingRequest>;
  return (
    typeof r.requestId === "string" && r.requestId.length > 0 &&
    typeof r.tool === "string" && r.tool.length > 0 &&
    // sessionId can legitimately be missing on per-session backlog
    // responses (the hook injects it via injectSessionId), so we
    // accept undefined here and validate downstream.
    (r.sessionId === undefined || typeof r.sessionId === "string")
  );
}

/**
 * Build the backlog GET / SSE URLs for a scope. Per-session shape comes
 * back without the sessionId in each entry (caller knows it from
 * context); the hook injects it back for uniform downstream handling.
 */
function endpointsFor(isAll: boolean, sessionId: string | null): {
  backlog: string | null;
  stream: string | null;
  injectSessionId: string | null;
} {
  if (isAll) {
    return {
      backlog: "/api/permission",
      stream: "/api/permission/stream",
      injectSessionId: null,
    };
  }
  if (sessionId) {
    const enc = encodeURIComponent(sessionId);
    return {
      backlog: `/api/sessions/${enc}/permission`,
      stream: `/api/sessions/${enc}/permission/stream`,
      injectSessionId: sessionId,
    };
  }
  return { backlog: null, stream: null, injectSessionId: null };
}

export function usePermissionQueue(scope: Scope): UsePermissionQueueResult {
  // Stable scope keys so effects only re-run when meaningful — `scope`
  // itself is referentially unstable across renders.
  const isAll = "all" in scope && scope.all === true;
  const sessionId = !isAll && "sessionId" in scope ? (scope.sessionId ?? null) : null;
  const scopeKey = isAll ? "*all*" : `s:${sessionId ?? ""}`;

  const [queue, setQueue] = useState<PendingRequest[]>([]);
  // Mirror the current scope key in state so we can detect a scope
  // change during render and reset the queue WITHOUT a setState-in-effect
  // (which lint flags as cascading renders). This is the React-recommended
  // "store-previous-prop + setState during render" pattern — React reruns
  // the component body but skips the wasted DOM commit.
  const [prevScopeKey, setPrevScopeKey] = useState(scopeKey);
  const remembered = useRef<Map<string, "allow" | "deny">>(new Map());
  const inFlight = useRef<Set<string>>(new Set());

  if (prevScopeKey !== scopeKey) {
    setPrevScopeKey(scopeKey);
    setQueue([]);
  }
  // Reset ref-stored memos when the scope key changes. Refs can't be
  // mutated during render (lint flags it), so we drop them in an effect
  // — this runs synchronously after commit, before any SSE event for
  // the new scope can land. Any "remember Bash for session A" state is
  // wiped before session B starts dispatching events.
  useEffect(() => {
    remembered.current = new Map();
    inFlight.current = new Set();
  }, [scopeKey]);

  const respond = useCallback(
    async (req: PendingRequest, decision: "allow" | "deny") => {
      try {
        await api.respondPermission(req.sessionId, req.requestId, {
          decision,
          reason: decision === "deny" ? "User denied via bridge UI" : undefined,
        });
      } catch {
        /* hook fails open on timeout; nothing to do */
      }
      setQueue((q) => reduceQueue(q, { kind: "answered", requestId: req.requestId }));
    },
    [],
  );

  const handle = useCallback(
    (req: PendingRequest) => {
      const memoKey = `${req.sessionId}:${req.tool}`;
      const memo = remembered.current.get(memoKey);
      if (memo) {
        if (inFlight.current.has(req.requestId)) return;
        inFlight.current.add(req.requestId);
        void respond(req, memo);
        return;
      }
      setQueue((q) => reduceQueue(q, { kind: "pending", req }));
    },
    [respond],
  );

  // Cross-scope dedup: the session-scoped consumer registers its
  // sessionId so the {all:true} consumer can skip duplicates.
  useEffect(() => {
    if (isAll) return;
    if (!sessionId) return;
    const reg = getActiveSessionRegistry();
    reg.add(sessionId);
    return () => { reg.remove(sessionId); };
  }, [sessionId, isAll]);

  // Backlog fetch + SSE subscribe. The scope-change reset above wipes
  // stale queue + memos during render, so by the time this effect runs
  // we know any previous-session state has been cleared.
  useEffect(() => {
    const endpoints = endpointsFor(isAll, sessionId);
    if (!endpoints.backlog || !endpoints.stream) return;

    let stopped = false;
    const reg = isAll ? getActiveSessionRegistry() : null;

    const ingest = (raw: PendingRequest) => {
      if (stopped) return;
      const req: PendingRequest = endpoints.injectSessionId
        ? { ...raw, sessionId: raw.sessionId ?? endpoints.injectSessionId }
        : raw;
      // After the inject step, sessionId MUST be a non-empty string —
      // `respond` calls api.respondPermission(req.sessionId, …) and
      // would otherwise build `/api/sessions/undefined/permission/…`
      // and surface a 400. The {all:true} scope provides sessionId in
      // the event payload; the per-session scope injects it. If
      // neither path produced one, the event is malformed — drop it
      // rather than queue a card the user can't actually answer.
      if (!req.sessionId || typeof req.sessionId !== "string") return;
      // {all:true} skips events for sessions that already have a
      // session-scoped consumer mounted, so we don't double-show.
      if (reg && reg.has(req.sessionId)) return;
      handle(req);
    };

    (async () => {
      try {
        const r = await fetch(endpoints.backlog!);
        if (!r.ok) return;
        const j = (await r.json()) as BacklogResponse;
        if (stopped || !Array.isArray(j.pending)) return;
        for (const p of j.pending) {
          if (isValidPendingRequest(p)) ingest(p);
        }
      } catch { /* ignore — SSE is the live source of truth */ }
    })();

    const es = new EventSource(endpoints.stream!);
    es.addEventListener("pending", (ev: MessageEvent) => {
      try {
        const parsed = JSON.parse(ev.data);
        if (isValidPendingRequest(parsed)) ingest(parsed);
      } catch { /* ignore malformed event */ }
    });
    es.addEventListener("answered", (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data) as { requestId?: unknown };
        if (typeof data.requestId !== "string" || data.requestId.length === 0) return;
        setQueue((q) => reduceQueue(q, { kind: "answered", requestId: data.requestId as string }));
      } catch { /* ignore */ }
    });
    es.onerror = () => { /* browser auto-retries */ };

    return () => {
      stopped = true;
      es.close();
    };
  }, [sessionId, isAll, handle]);

  const answer = useCallback(
    async (req: PendingRequest, decision: "allow" | "deny", remember: boolean) => {
      if (remember) {
        remembered.current.set(`${req.sessionId}:${req.tool}`, decision);
      }
      await respond(req, decision);
    },
    [respond],
  );

  return { queue, respond, answer };
}
