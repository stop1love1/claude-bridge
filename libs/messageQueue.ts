import type { ChatSettings } from "./spawn";

export interface QueuedMessage {
  message: string;
  cwd: string;
  settings: ChatSettings;
  settingsPath: string;
  context?: string;
  enqueuedAt: number;
}

interface QueueState {
  byId: Map<string, QueuedMessage[]>;
}

const G = globalThis as unknown as { __bridgeMessageQueue?: QueueState };
const state: QueueState = G.__bridgeMessageQueue ?? { byId: new Map() };
G.__bridgeMessageQueue = state;

export function enqueueMessage(sessionId: string, msg: QueuedMessage): number {
  let list = state.byId.get(sessionId);
  if (!list) {
    list = [];
    state.byId.set(sessionId, list);
  }
  list.push(msg);
  return list.length;
}

export function dequeueMessage(sessionId: string): QueuedMessage | null {
  const list = state.byId.get(sessionId);
  if (!list || list.length === 0) return null;
  const next = list.shift()!;
  if (list.length === 0) state.byId.delete(sessionId);
  return next;
}

export function queueLength(sessionId: string): number {
  return state.byId.get(sessionId)?.length ?? 0;
}

export function clearQueue(sessionId: string): number {
  const len = state.byId.get(sessionId)?.length ?? 0;
  state.byId.delete(sessionId);
  return len;
}

export function _resetAllQueuesForTest(): void {
  state.byId.clear();
}
