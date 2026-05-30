"use client";

/**
 * Per-session token-streaming partials store.
 *
 * Why this lives outside `SessionLogInner`'s `useState`:
 *
 * Token streaming over SSE fires `partial` events at ~50 Hz on a long
 * model reply. When `partials` was a plain `useState<Record<string,
 * string>>`, every keystroke caused `SessionLogInner` to re-render,
 * which reconciled the entire 300-row chat tree (memoised `LogRow`s
 * still pay the React traversal cost — `memo` skips RENDER, not the
 * VDOM walk that compares props for every row). Profiler showed ~12 ms
 * per token tick on a 200-row session.
 *
 * Lifting the partials buffer into a `useSyncExternalStore`-backed
 * module makes only the components that subscribe re-render. The
 * streaming "ghost" assistant row (`StreamingAssistantRow` family) reads
 * one specific message id; the empty-state placeholder reads "is the
 * map empty?". The rest of the tree never re-renders on token deltas.
 *
 * Listener granularity: each message id has its OWN listener set, and the
 * key-set watchers are a separate set. A text delta for message A fires
 * only A's text listeners (plus the key-set watchers when the *set* of
 * ids changes) — NOT every other streaming row's listener. Sharing one
 * session-wide listener set used to make this O(M²): M streaming rows
 * each re-rendering on every one of M streams' deltas.
 *
 * Scoped by `sessionId` so a stale partial from a previously-mounted
 * session can't bleed into a different session — the SessionLog wrapper
 * remounts the inner on session change, but the store lives across
 * mounts and would otherwise leak.
 */

type Partials = Record<string, string>;
type Listener = () => void;

interface SessionEntry {
  partials: Partials;
  // Stable snapshot for `useSyncExternalStore`. Replaced (not mutated)
  // on every key-set change so React's strict-equality bail-out works.
  snapshotKeys: string[];
  // Watchers of the key SET (which ids are streaming). Fire only when an
  // id is added / removed.
  keyListeners: Set<Listener>;
  // Per-message-id text watchers. Fire on every append to THAT id only.
  textListeners: Map<string, Set<Listener>>;
}

const sessions = new Map<string, SessionEntry>();

/**
 * Cap per-message buffer at ~256 KB. A pathologically long model reply
 * (10k+ tokens) would otherwise hold the entire stream in memory until
 * the canonical .jsonl line lands and replaces the partial. The
 * canonical line is the source of truth anyway; once we hit the cap,
 * stop appending and keep what we have. Same threshold the original
 * `useState`-based implementation used.
 */
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

/** Drop the session entry once nothing references it — no listeners of
 *  either kind and no buffered text. Never drop while text is buffered:
 *  a remount would re-initialise to empty and lose the ghost row mid-
 *  stream. */
function maybeGc(sessionId: string, entry: SessionEntry): void {
  if (
    entry.keyListeners.size === 0 &&
    entry.textListeners.size === 0 &&
    Object.keys(entry.partials).length === 0
  ) {
    sessions.delete(sessionId);
  }
}

/** Recompute the key snapshot (new array identity) and fire the key-set
 *  watchers. Call only when the SET of ids changed. */
function notifyKeys(entry: SessionEntry): void {
  entry.snapshotKeys = Object.keys(entry.partials);
  for (const l of entry.keyListeners) {
    try { l(); } catch { /* never let one listener break the rest */ }
  }
}

/** Fire only the text watchers for one message id. */
function notifyText(entry: SessionEntry, messageId: string): void {
  const set = entry.textListeners.get(messageId);
  if (!set) return;
  for (const l of set) {
    try { l(); } catch { /* never let one listener break the rest */ }
  }
}

/**
 * Append a fragment to a streaming partial. No-op if the per-message
 * buffer is already at the cap.
 */
export function appendPartial(sessionId: string, messageId: string, text: string): void {
  if (!text) return;
  const entry = getEntry(sessionId);
  const cur = entry.partials[messageId] ?? "";
  if (cur.length >= PARTIAL_CAP_BYTES) return;
  const isNewId = entry.partials[messageId] === undefined;
  entry.partials = { ...entry.partials, [messageId]: cur + text };
  // A brand-new id changes the key set → tell the key-set watchers (this
  // also refreshes snapshotKeys). Pure growth on an existing id does not.
  if (isNewId) notifyKeys(entry);
  notifyText(entry, messageId);
}

/**
 * Drop specific message ids when their canonical assistant lines land
 * AND drop any sentinel `live:*` keys that were placeholders for an
 * unknown id. No-op (no notify) when nothing actually changed.
 */
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
  // Tell the (still-mounted) streaming rows for the removed ids so they
  // re-read an empty snapshot and unmount their ghost text.
  for (const id of removed) notifyText(entry, id);
}

/**
 * Clear every partial for a session. Called when the SSE child reports
 * `alive: false` and we want to sweep the ghost row a couple of seconds
 * later.
 */
export function clearPartials(sessionId: string): void {
  const entry = sessions.get(sessionId);
  if (!entry) return;
  const removed = Object.keys(entry.partials);
  if (removed.length === 0) return;
  entry.partials = {};
  notifyKeys(entry);
  for (const id of removed) notifyText(entry, id);
}

/**
 * Test helper: drop every session's state. Exported so unit tests can
 * isolate themselves without colliding on shared module state.
 */
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

/**
 * Stable empty array used as the SSR / no-entry snapshot for
 * `subscribePartialKeys`. Returning a fresh `[]` every call would
 * defeat React's `useSyncExternalStore` strict-equality bail-out.
 */
const EMPTY_KEYS: readonly string[] = Object.freeze([]);

/**
 * Subscriber for the list of message ids that currently have any
 * streaming text. Suitable for `useSyncExternalStore`. Re-fires only
 * when an id is added / removed; pure text growth on an existing id
 * does NOT change the key set, so the row map's identity stays stable
 * — only the per-id text subscribers re-render.
 */
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
      // `snapshotKeys` is replaced (new array identity) every time the
      // key set changes — see `notifyKeys()`. Suitable for the stability
      // guarantee `useSyncExternalStore` requires.
      return entry.snapshotKeys;
    },
  };
}

/**
 * Subscriber for one message id's accumulated text. Re-fires on every
 * append to THAT id; consumers should be small components (just the
 * streaming row) so the per-token re-render cost stays bounded.
 */
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
