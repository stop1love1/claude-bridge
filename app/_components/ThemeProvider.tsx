"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";

/**
 * Three-state theme preference:
 *   - "system" → follow `prefers-color-scheme` (default for new visitors)
 *   - "dark"   → force dark
 *   - "light"  → force light
 *
 * The *resolved* concrete value applied to the DOM is always either
 * "dark" or "light" — `resolved` exposes it so components can render
 * the correct icon without re-querying the media list.
 */
export type ThemePref = "dark" | "light" | "system";
export type ThemeResolved = "dark" | "light";

export const STORAGE_KEY = "bridge.theme";

interface ThemeCtx {
  pref: ThemePref;
  resolved: ThemeResolved;
  setPref: (p: ThemePref) => void;
  /**
   * `false` during SSR + the very first client render so consumers can
   * render a hydration-safe placeholder. Flips to `true` in a post-mount
   * effect once we've read `localStorage` / `matchMedia`.
   */
  mounted: boolean;
}

const Ctx = createContext<ThemeCtx | null>(null);

function applyDom(t: ThemeResolved) {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", t);
  document.documentElement.style.colorScheme = t;
}

/**
 * No-flash bootstrap script. Runs synchronously in the document <head>
 * before React mounts so the painted markup matches the user's saved
 * preference (or system default), avoiding a dark-to-light flash on
 * navigation. Self-contained IIFE — see ThemeProvider for how it's
 * loaded from app/layout.tsx.
 */
// JSON.stringify the storage key rather than dropping it into a single-
// quoted string literal raw — a future change that put a quote, a
// newline, or `</script>` into STORAGE_KEY would otherwise break or
// open a script-injection in the inlined boot script.
export const NO_FLASH_SCRIPT = `(function(){try{var k=${JSON.stringify(STORAGE_KEY)};var s=localStorage.getItem(k);var t;if(s==='dark'||s==='light'){t=s;}else{t=window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';}var d=document.documentElement;d.setAttribute('data-theme',t);d.style.colorScheme=t;}catch(e){}})();`;

// External-store adapters — let `useSyncExternalStore` handle SSR
// hydration without a `useState` + `useEffect(setX)` ladder, which
// would trip React 19's `set-state-in-effect` rule. Each adapter
// returns the current snapshot from the browser API and subscribes
// to native change events; the *server* snapshot is the SSR default.

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
  } catch { /* ignore */ }
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

// "Has React handed control over to the client yet?" — the canonical
// SSR-safe trick. Server snapshot is `false`; client snapshot is
// `true`; no subscribe needed because the value never changes after
// hydration.
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

  // Apply the resolved theme on every change. Skipped before mount so
  // we don't clobber whatever the no-flash script set during the first
  // paint (which already matches the user's saved preference).
  useEffect(() => {
    if (!mounted) return;
    applyDom(resolved);
  }, [mounted, resolved]);

  const setPref = useCallback((p: ThemePref) => {
    try {
      if (p === "system") window.localStorage.removeItem(STORAGE_KEY);
      else window.localStorage.setItem(STORAGE_KEY, p);
    } catch { /* ignore */ }
    // Manual writes don't fire `storage` (that event is cross-tab
    // only), so dispatch one ourselves to nudge the
    // `useSyncExternalStore` subscribers in this tab.
    try {
      window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
    } catch { /* older browsers */ }
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
