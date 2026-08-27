"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import { THEME_STORAGE_KEY } from "@/libs/themeBootstrap";

export type ThemePref = "dark" | "light" | "system";
export type ThemeResolved = "dark" | "light";

export const STORAGE_KEY = THEME_STORAGE_KEY;

interface ThemeCtx {
  pref: ThemePref;
  resolved: ThemeResolved;
  setPref: (p: ThemePref) => void;
  mounted: boolean;
}

const Ctx = createContext<ThemeCtx | null>(null);

function applyDom(t: ThemeResolved) {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", t);
  document.documentElement.style.colorScheme = t;
}


function subscribePref(cb: () => void) {
  if (typeof window === "undefined") return () => {};
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY || e.key === null) cb();
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}
function getPrefSnapshot(): ThemePref {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v === "dark" || v === "light" || v === "system") return v;
  } catch { }
  return "system";
}
function getPrefServerSnapshot(): ThemePref { return "system"; }

function subscribeSystem(cb: () => void) {
  if (typeof window === "undefined") return () => {};
  const mq = window.matchMedia("(prefers-color-scheme: light)");
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}
function getSystemSnapshot(): ThemeResolved {
  return window.matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}
function getSystemServerSnapshot(): ThemeResolved { return "dark"; }

function noopSubscribe() { return () => {}; }
function getMountedClient(): boolean { return true; }
function getMountedServer(): boolean { return false; }

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const pref = useSyncExternalStore(
    subscribePref,
    getPrefSnapshot,
    getPrefServerSnapshot,
  );
  const system = useSyncExternalStore(
    subscribeSystem,
    getSystemSnapshot,
    getSystemServerSnapshot,
  );
  const mounted = useSyncExternalStore(
    noopSubscribe,
    getMountedClient,
    getMountedServer,
  );

  const resolved: ThemeResolved = pref === "system" ? system : pref;

  useEffect(() => {
    if (!mounted) return;
    applyDom(resolved);
  }, [mounted, resolved]);

  const setPref = useCallback((p: ThemePref) => {
    try {
      if (p === "system") window.localStorage.removeItem(STORAGE_KEY);
      else window.localStorage.setItem(STORAGE_KEY, p);
    } catch { }
    try {
      window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
    } catch { }
  }, []);

  const value = useMemo(
    () => ({ pref, resolved, setPref, mounted }),
    [pref, resolved, setPref, mounted],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider>");
  return ctx;
}
