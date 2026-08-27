"use client";


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
  } catch { }
}

function notifyKey(key: string): void {
  listeners.get(key)?.forEach((l) => l());
}

function ensureSubscribed(key: string): () => void {
  if (typeof window === "undefined") return () => {};
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
