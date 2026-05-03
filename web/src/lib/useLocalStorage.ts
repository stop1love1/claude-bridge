/**
 * Cross-tab-aware `localStorage` hook backed by `useSyncExternalStore`.
 * Vite has no SSR, so the `serverValue` parameter is kept only for API
 * compatibility with the Next.js source — it's threaded through
 * `getServerSnapshot`, which React uses for the very first sync render
 * before subscriptions attach.
 *
 * Why a module-level cache?
 *   `useSyncExternalStore` compares snapshots with `Object.is`. If
 *   `getSnapshot` returns a freshly-parsed object every call, the
 *   store loops forever. The cache hands back the *same reference*
 *   until the value actually changes (cross-tab `storage` event or
 *   our own `setValue` write).
 *
 * Cross-tab semantics:
 *   The browser fires `storage` events on *other* tabs only. Our
 *   `setValue` calls `notifyKey` directly so listeners in the *same*
 *   tab get notified too — without that, a write here wouldn't
 *   re-render the consumer.
 */

import { useCallback, useSyncExternalStore } from "react";

type Loader<T> = (raw: string | null) => T;
type Dumper<T> = (value: T) => string | null;

interface CacheEntry { raw: string | null; value: unknown }
const cache = new Map<string, CacheEntry>();
const listeners = new Map<string, Set<() => void>>();

function readRaw(key: string): string | null {
  if (typeof window === "undefined") return null;
  try { return window.localStorage.getItem(key); } catch { return null; }
}

function writeRaw(key: string, raw: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (raw === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, raw);
  } catch { /* quota / disabled */ }
}

function notifyKey(key: string): void {
  listeners.get(key)?.forEach((l) => l());
}

function ensureSubscribed(key: string): () => void {
  if (typeof window === "undefined") return () => {};
  // Only install the global storage listener once per key — repeated
  // subscriptions just join the in-memory set.
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
    const onStorage = (e: StorageEvent) => {
      if (e.key !== key && e.key !== null) return;
      cache.delete(key);
      notifyKey(key);
    };
    window.addEventListener("storage", onStorage);
  }
  return () => {
    // We never tear down the global listener — keys persist for the
    // lifetime of the page. The per-component listener is enough to
    // stop notifying unmounted consumers.
  };
}

function getCachedTyped<T>(key: string, load: Loader<T>): T {
  const raw = readRaw(key);
  const hit = cache.get(key);
  if (hit && hit.raw === raw) return hit.value as T;
  const value = load(raw);
  cache.set(key, { raw, value });
  return value;
}

/**
 * @param key            localStorage key
 * @param load           parse the raw string (or `null` for "missing")
 *                       into your typed value. Must be referentially
 *                       stable across renders — pass a top-level
 *                       function or `useCallback` it.
 * @param serverValue    initial snapshot returned for `getServerSnapshot`.
 *                       Kept for API parity with the Next.js version;
 *                       in this Vite SPA it's effectively the default
 *                       on the very first render before subscription.
 * @param dump           serialize the typed value back to a raw
 *                       string for `setValue`. Optional — omit for
 *                       read-only stores.
 */
export function useLocalStorage<T>(
  key: string,
  load: Loader<T>,
  serverValue: T,
  dump?: Dumper<T>,
): [T, (value: T) => void] {
  const subscribe = useCallback(
    (cb: () => void) => {
      ensureSubscribed(key);
      const set = listeners.get(key)!;
      set.add(cb);
      return () => set.delete(cb);
    },
    [key],
  );

  const getSnapshot = useCallback(() => getCachedTyped(key, load), [key, load]);
  const getServerSnapshot = useCallback(() => serverValue, [serverValue]);

  const value = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setValue = useCallback(
    (next: T) => {
      const raw = dump ? dump(next) : (next === null ? null : String(next));
      writeRaw(key, raw);
      cache.set(key, { raw, value: next });
      notifyKey(key);
    },
    [key, dump],
  );

  return [value, setValue];
}

/**
 * Convenience for JSON-backed values. Defaults the loader / dumper
 * so callers just pass a key + default.
 */
export function useLocalStorageJSON<T>(
  key: string,
  defaultValue: T,
): [T, (value: T) => void] {
  const load = useCallback(
    (raw: string | null): T => {
      if (raw === null) return defaultValue;
      try { return JSON.parse(raw) as T; } catch { return defaultValue; }
    },
    [defaultValue],
  );
  const dump = useCallback((v: T): string => JSON.stringify(v), []);
  return useLocalStorage(key, load, defaultValue, dump);
}
