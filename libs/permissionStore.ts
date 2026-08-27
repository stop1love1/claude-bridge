import { EventEmitter } from "node:events";


export type PendingStatus = "pending" | "allow" | "deny";

export interface PendingRequest {
  sessionId: string;
  requestId: string;
  tool: string;
  input: unknown;
  status: PendingStatus;
  reason?: string;
  createdAt: string;
}

interface Store {
  pending: Map<string, PendingRequest>;
  emitters: Map<string, EventEmitter>;
  globalEmitter: EventEmitter;
}

const G = globalThis as unknown as { __bridgePermissionStore?: Store };
const store: Store = G.__bridgePermissionStore ?? {
  pending: new Map(),
  emitters: new Map(),
  globalEmitter: (() => { const e = new EventEmitter(); e.setMaxListeners(0); return e; })(),
};
if (!store.globalEmitter) {
  const e = new EventEmitter();
  e.setMaxListeners(0);
  store.globalEmitter = e;
}
G.__bridgePermissionStore = store;

function key(sessionId: string, requestId: string): string {
  return `${sessionId}:${requestId}`;
}

function emitterFor(sessionId: string): EventEmitter {
  let e = store.emitters.get(sessionId);
  if (!e) {
    e = new EventEmitter();
    e.setMaxListeners(0);
    store.emitters.set(sessionId, e);
  }
  return e;
}

export function announcePending(req: Omit<PendingRequest, "status">): PendingRequest {
  const full: PendingRequest = { ...req, status: "pending" };
  store.pending.set(key(req.sessionId, req.requestId), full);
  emitterFor(req.sessionId).emit("pending", full);
  store.globalEmitter.emit("pending", full);
  return full;
}

export function getPending(sessionId: string, requestId: string): PendingRequest | undefined {
  return store.pending.get(key(sessionId, requestId));
}

export function listPending(sessionId: string): PendingRequest[] {
  const out: PendingRequest[] = [];
  for (const v of store.pending.values()) {
    if (v.sessionId === sessionId && v.status === "pending") out.push(v);
  }
  return out;
}

export function subscribeAllPermissions(
  cb: (req: PendingRequest) => void,
): () => void {
  const handler = (req: PendingRequest) => {
    try { cb(req); } catch { }
  };
  store.globalEmitter.on("pending", handler);
  return () => store.globalEmitter.off("pending", handler);
}

export function listAllPending(): PendingRequest[] {
  const out: PendingRequest[] = [];
  for (const v of store.pending.values()) {
    if (v.status === "pending") out.push(v);
  }
  return out;
}

export function answer(
  sessionId: string,
  requestId: string,
  decision: "allow" | "deny",
  reason?: string,
): PendingRequest | null {
  const k = key(sessionId, requestId);
  const cur = store.pending.get(k);
  if (!cur) return null;
  cur.status = decision;
  cur.reason = reason;
  store.pending.set(k, cur);
  emitterFor(sessionId).emit("answered", cur);
  store.globalEmitter.emit("answered", cur);
  return cur;
}

export function consume(sessionId: string, requestId: string): void {
  store.pending.delete(key(sessionId, requestId));
  const e = store.emitters.get(sessionId);
  if (!e) return;
  if (e.listenerCount("pending") > 0 || e.listenerCount("answered") > 0) return;
  for (const v of store.pending.values()) {
    if (v.sessionId === sessionId) return;
  }
  store.emitters.delete(sessionId);
}

export function subscribe(
  sessionId: string,
  onPending: (r: PendingRequest) => void,
  onAnswered?: (r: PendingRequest) => void,
): () => void {
  const e = emitterFor(sessionId);
  e.on("pending", onPending);
  if (onAnswered) e.on("answered", onAnswered);
  return () => {
    e.off("pending", onPending);
    if (onAnswered) e.off("answered", onAnswered);
  };
}

export function _emitterDebugInfo(sessionId: string): { exists: boolean; pending: number; answered: number } {
  const e = store.emitters.get(sessionId);
  if (!e) return { exists: false, pending: 0, answered: 0 };
  return { exists: true, pending: e.listenerCount("pending"), answered: e.listenerCount("answered") };
}

export function _globalEmitterDebugInfo(): { pending: number; answered: number } {
  return {
    pending: store.globalEmitter.listenerCount("pending"),
    answered: store.globalEmitter.listenerCount("answered"),
  };
}

export function subscribeAll(
  onPending: (r: PendingRequest) => void,
  onAnswered?: (r: PendingRequest) => void,
): () => void {
  store.globalEmitter.on("pending", onPending);
  if (onAnswered) store.globalEmitter.on("answered", onAnswered);
  return () => {
    store.globalEmitter.off("pending", onPending);
    if (onAnswered) store.globalEmitter.off("answered", onAnswered);
  };
}
