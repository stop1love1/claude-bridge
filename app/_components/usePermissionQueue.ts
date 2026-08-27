"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/libs/client/api";


export interface PendingRequest {
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
  if (!prev.some((r) => r.requestId === evt.requestId)) return prev;
  return prev.filter((r) => r.requestId !== evt.requestId);
}

export interface UsePermissionQueueResult {
  queue: PendingRequest[];
  respond: (req: PendingRequest, decision: "allow" | "deny") => Promise<void>;
  answer: (req: PendingRequest, decision: "allow" | "deny", remember: boolean) => Promise<void>;
}

interface BacklogResponse { pending?: PendingRequest[] }

function isValidPendingRequest(x: unknown): x is PendingRequest {
  if (!x || typeof x !== "object") return false;
  const r = x as Partial<PendingRequest>;
  return (
    typeof r.requestId === "string" && r.requestId.length > 0 &&
    typeof r.tool === "string" && r.tool.length > 0 &&
    (r.sessionId === undefined || typeof r.sessionId === "string")
  );
}

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
  const isAll = "all" in scope && scope.all === true;
  const sessionId = !isAll && "sessionId" in scope ? (scope.sessionId ?? null) : null;
  const scopeKey = isAll ? "*all*" : `s:${sessionId ?? ""}`;

  const [queue, setQueue] = useState<PendingRequest[]>([]);
  const [prevScopeKey, setPrevScopeKey] = useState(scopeKey);
  const remembered = useRef<Map<string, "allow" | "deny">>(new Map());
  const inFlight = useRef<Set<string>>(new Set());

  if (prevScopeKey !== scopeKey) {
    setPrevScopeKey(scopeKey);
    setQueue([]);
  }
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

  useEffect(() => {
    if (isAll) return;
    if (!sessionId) return;
    const reg = getActiveSessionRegistry();
    reg.add(sessionId);
    return () => { reg.remove(sessionId); };
  }, [sessionId, isAll]);

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
      if (!req.sessionId || typeof req.sessionId !== "string") return;
      if (reg && reg.has(req.sessionId)) return;
      handle(req);
    };

    const loadBacklog = async () => {
      try {
        const r = await fetch(endpoints.backlog!);
        if (!r.ok) return;
        const j = (await r.json()) as BacklogResponse;
        if (stopped || !Array.isArray(j.pending)) return;
        for (const p of j.pending) {
          if (isValidPendingRequest(p)) ingest(p);
        }
      } catch { }
    };

    let es: EventSource | null = null;
    const openStream = () => {
      if (stopped || es) return;
      void loadBacklog();
      es = new EventSource(endpoints.stream!);
      es.addEventListener("pending", (ev: MessageEvent) => {
        try {
          const parsed = JSON.parse(ev.data);
          if (isValidPendingRequest(parsed)) ingest(parsed);
        } catch { }
      });
      es.addEventListener("answered", (ev: MessageEvent) => {
        try {
          const data = JSON.parse(ev.data) as { requestId?: unknown };
          if (typeof data.requestId !== "string" || data.requestId.length === 0) return;
          setQueue((q) => reduceQueue(q, { kind: "answered", requestId: data.requestId as string }));
        } catch { }
      });
      es.onerror = () => { };
    };
    const closeStream = () => {
      if (es) { es.close(); es = null; }
    };
    const onVis = () => {
      if (document.visibilityState === "hidden") closeStream();
      else openStream();
    };

    const hasDoc = typeof document !== "undefined";
    if (!hasDoc || document.visibilityState !== "hidden") openStream();
    if (hasDoc) document.addEventListener("visibilitychange", onVis);

    return () => {
      stopped = true;
      if (hasDoc) document.removeEventListener("visibilitychange", onVis);
      closeStream();
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
