
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";

export interface PendingLogin {
  id: string;
  email: string;
  trust: boolean;
  deviceLabel: string;
  remoteIp: string;
  userAgent: string;
  createdAt: string;
  expiresAt: number;
  status: "pending" | "approved" | "denied";
  reason?: string;
}

interface Store {
  pending: Map<string, PendingLogin>;
  emitter: EventEmitter;
}

const G = globalThis as unknown as { __bridgeLoginApprovals?: Store };
const store: Store =
  G.__bridgeLoginApprovals ?? {
    pending: new Map<string, PendingLogin>(),
    emitter: (() => {
      const e = new EventEmitter();
      e.setMaxListeners(0);
      return e;
    })(),
  };
if (!store.emitter) {
  const e = new EventEmitter();
  e.setMaxListeners(0);
  store.emitter = e;
}
G.__bridgeLoginApprovals = store;

export const APPROVAL_TTL_MS = 3 * 60 * 1000;

function now(): number {
  return Date.now();
}

function newId(): string {
  return randomBytes(8).toString("hex");
}

function pruneExpired(): void {
  const t = now();
  for (const [id, entry] of store.pending) {
    if (entry.status === "pending" && entry.expiresAt <= t) {
      store.pending.delete(id);
      continue;
    }
    if (entry.status !== "pending" && entry.expiresAt + 2 * 60 * 1000 <= t) {
      store.pending.delete(id);
    }
  }
}

export function createPendingLogin(args: {
  email: string;
  trust: boolean;
  deviceLabel: string;
  remoteIp: string;
  userAgent: string;
}): PendingLogin {
  pruneExpired();
  const t = now();
  const entry: PendingLogin = {
    id: newId(),
    email: args.email,
    trust: args.trust,
    deviceLabel: args.deviceLabel,
    remoteIp: args.remoteIp,
    userAgent: args.userAgent,
    createdAt: new Date(t).toISOString(),
    expiresAt: t + APPROVAL_TTL_MS,
    status: "pending",
  };
  store.pending.set(entry.id, entry);
  store.emitter.emit("pending", entry);
  return entry;
}

export function subscribeLoginApprovals(
  cb: (entry: PendingLogin) => void,
): () => void {
  const handler = (entry: PendingLogin) => {
    try {
      cb(entry);
    } catch {
    }
  };
  store.emitter.on("pending", handler);
  return () => store.emitter.off("pending", handler);
}

export function getPendingLogin(id: string): PendingLogin | null {
  pruneExpired();
  return store.pending.get(id) ?? null;
}

export function answerPendingLogin(
  id: string,
  decision: "approved" | "denied",
  reason?: string,
): PendingLogin | null {
  pruneExpired();
  const entry = store.pending.get(id);
  if (!entry) return null;
  if (entry.status !== "pending") return entry;
  entry.status = decision;
  if (reason) entry.reason = reason.slice(0, 200);
  store.pending.set(id, entry);
  return entry;
}

export function consumePendingLogin(id: string): void {
  store.pending.delete(id);
}

export function listPendingLogins(): PendingLogin[] {
  pruneExpired();
  const out: PendingLogin[] = [];
  for (const entry of store.pending.values()) {
    if (entry.status === "pending") out.push(entry);
  }
  out.sort((a, b) => b.expiresAt - a.expiresAt);
  return out;
}
