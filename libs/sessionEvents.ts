import { EventEmitter } from "node:events";

export interface PartialEvent {
  messageId: string;
  index: number;
  text: string;
}

export interface StatusEvent {
  kind: "thinking" | "running" | "idle";
  label?: string;
}

interface SessionEventsRegistry {
  emitters: Map<string, EventEmitter>;
  alive: Map<string, boolean>;
}

const G = globalThis as unknown as { __bridgeSessionEvents?: SessionEventsRegistry };
const registry: SessionEventsRegistry = G.__bridgeSessionEvents ?? {
  emitters: new Map(),
  alive: new Map(),
};
G.__bridgeSessionEvents = registry;

function getEmitter(sessionId: string): EventEmitter {
  let e = registry.emitters.get(sessionId);
  if (!e) {
    e = new EventEmitter();
    e.setMaxListeners(100);
    registry.emitters.set(sessionId, e);
  }
  return e;
}

export function emitPartial(sessionId: string, p: PartialEvent): void {
  getEmitter(sessionId).emit("partial", p);
}

export function emitAlive(sessionId: string, alive: boolean): void {
  registry.alive.set(sessionId, alive);
  getEmitter(sessionId).emit("alive", alive);
  if (!alive) scheduleEvict(sessionId);
}

const EVICT_DELAY_MS = 60_000;
const evictTimers = new Map<string, ReturnType<typeof setTimeout>>();
function scheduleEvict(sessionId: string): void {
  const existing = evictTimers.get(sessionId);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    evictTimers.delete(sessionId);
    const e = registry.emitters.get(sessionId);
    if (e && e.listenerCount("partial") + e.listenerCount("alive") + e.listenerCount("status") > 0) {
      scheduleEvict(sessionId);
      return;
    }
    registry.emitters.delete(sessionId);
    registry.alive.delete(sessionId);
  }, EVICT_DELAY_MS);
  if (typeof t === "object" && t !== null && "unref" in t) {
    (t as { unref: () => void }).unref();
  }
  evictTimers.set(sessionId, t);
}

export function emitStatus(sessionId: string, s: StatusEvent): void {
  getEmitter(sessionId).emit("status", s);
}

export function isAlive(sessionId: string): boolean {
  return registry.alive.get(sessionId) ?? false;
}

export interface SessionSubscriptionHandlers {
  onPartial?: (p: PartialEvent) => void;
  onAlive?: (alive: boolean) => void;
  onStatus?: (s: StatusEvent) => void;
}

export function subscribeSession(
  sessionId: string,
  handlers: SessionSubscriptionHandlers,
): () => void {
  const e = getEmitter(sessionId);
  if (handlers.onPartial) e.on("partial", handlers.onPartial);
  if (handlers.onAlive) e.on("alive", handlers.onAlive);
  if (handlers.onStatus) e.on("status", handlers.onStatus);
  return () => {
    if (handlers.onPartial) e.off("partial", handlers.onPartial);
    if (handlers.onAlive) e.off("alive", handlers.onAlive);
    if (handlers.onStatus) e.off("status", handlers.onStatus);
  };
}
