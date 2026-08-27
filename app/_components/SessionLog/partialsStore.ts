"use client";


type Partials = Record<string, string>;
type Listener = () => void;

interface SessionEntry {
  partials: Partials;
  snapshotKeys: string[];
  keyListeners: Set<Listener>;
  textListeners: Map<string, Set<Listener>>;
}

const sessions = new Map<string, SessionEntry>();

const PARTIAL_CAP_BYTES = 256 * 1024;

function getEntry(sessionId: string): SessionEntry {
  let entry = sessions.get(sessionId);
  if (!entry) {
    entry = {
      partials: {},
      snapshotKeys: [],
      keyListeners: new Set(),
      textListeners: new Map(),
    };
    sessions.set(sessionId, entry);
  }
  return entry;
}

function maybeGc(sessionId: string, entry: SessionEntry): void {
  if (
    entry.keyListeners.size === 0 &&
    entry.textListeners.size === 0 &&
    Object.keys(entry.partials).length === 0
  ) {
    sessions.delete(sessionId);
  }
}

function notifyKeys(entry: SessionEntry): void {
  entry.snapshotKeys = Object.keys(entry.partials);
  for (const l of entry.keyListeners) {
    try { l(); } catch { }
  }
}

function notifyText(entry: SessionEntry, messageId: string): void {
  const set = entry.textListeners.get(messageId);
  if (!set) return;
  for (const l of set) {
    try { l(); } catch { }
  }
}

export function appendPartial(sessionId: string, messageId: string, text: string): void {
  if (!text) return;
  const entry = getEntry(sessionId);
  const cur = entry.partials[messageId] ?? "";
  if (cur.length >= PARTIAL_CAP_BYTES) return;
  const isNewId = entry.partials[messageId] === undefined;
  entry.partials = { ...entry.partials, [messageId]: cur + text };
  if (isNewId) notifyKeys(entry);
  notifyText(entry, messageId);
}

export function dropOnArrival(sessionId: string, arrivedIds: Iterable<string>): void {
  const entry = sessions.get(sessionId);
  if (!entry) return;
  const removed: string[] = [];
  const next = { ...entry.partials };
  for (const id of arrivedIds) {
    if (next[id] !== undefined) {
      delete next[id];
      removed.push(id);
    }
  }
  for (const k of Object.keys(next)) {
    if (k.startsWith("live:")) {
      delete next[k];
      removed.push(k);
    }
  }
  if (removed.length === 0) return;
  entry.partials = next;
  notifyKeys(entry);
  for (const id of removed) notifyText(entry, id);
}

export function clearPartials(sessionId: string): void {
  const entry = sessions.get(sessionId);
  if (!entry) return;
  const removed = Object.keys(entry.partials);
  if (removed.length === 0) return;
  entry.partials = {};
  notifyKeys(entry);
  for (const id of removed) notifyText(entry, id);
}

export function __resetPartialsStoreForTests(): void {
  for (const e of sessions.values()) {
    e.keyListeners.clear();
    e.textListeners.clear();
  }
  sessions.clear();
}

interface Subscriber<T> {
  subscribe: (listener: Listener) => () => void;
  getSnapshot: () => T;
}

const EMPTY_KEYS: readonly string[] = Object.freeze([]);

export function subscribePartialKeys(sessionId: string): Subscriber<readonly string[]> {
  return {
    subscribe(listener) {
      const entry = getEntry(sessionId);
      entry.keyListeners.add(listener);
      return () => {
        entry.keyListeners.delete(listener);
        maybeGc(sessionId, entry);
      };
    },
    getSnapshot() {
      const entry = sessions.get(sessionId);
      if (!entry) return EMPTY_KEYS;
      return entry.snapshotKeys;
    },
  };
}

export function subscribePartialText(sessionId: string, messageId: string): Subscriber<string> {
  return {
    subscribe(listener) {
      const entry = getEntry(sessionId);
      let set = entry.textListeners.get(messageId);
      if (!set) {
        set = new Set();
        entry.textListeners.set(messageId, set);
      }
      set.add(listener);
      return () => {
        const s = entry.textListeners.get(messageId);
        if (s) {
          s.delete(listener);
          if (s.size === 0) entry.textListeners.delete(messageId);
        }
        maybeGc(sessionId, entry);
      };
    },
    getSnapshot() {
      return sessions.get(sessionId)?.partials[messageId] ?? "";
    },
  };
}
