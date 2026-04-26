"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
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
export const NO_FLASH_SCRIPT = `(function(){try{var k='${STORAGE_KEY}';var s=localStorage.getItem(k);var t;if(s==='dark'||s==='light'){t=s;}else{t=window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';}var d=document.documentElement;d.setAttribute('data-theme',t);d.style.colorScheme=t;}catch(e){}})();`;

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // SSR-safe defaults: NEVER read localStorage / matchMedia in the
  // initializer. The server has neither, and a useState initializer
  // that returns different values on server vs client guarantees a
  // hydration mismatch the moment any consumer renders the icon.
  // The real preference is loaded after mount; the no-flash script
  // (in <head>) handles the visual side until then.
  const [pref, setPrefState] = useState<ThemePref>("system");
  const [system, setSystem] = useState<ThemeResolved>("dark");
  const [mounted, setMounted] = useState(false);

  // Mount-time hydration of the real values from the browser. We do
  // both reads in one effect so consumers flip from "placeholder" to
  // "actual" in a single render pass.
  useEffect(() => {
    let nextPref: ThemePref = "system";
    try {
      const v = window.localStorage.getItem(STORAGE_KEY);
      if (v === "dark" || v === "light" || v === "system") nextPref = v;
    } catch { /* ignore */ }
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const nextSystem: ThemeResolved = mq.matches ? "light" : "dark";
    setPrefState(nextPref);
    setSystem(nextSystem);
    setMounted(true);
  }, []);

  // Track OS theme changes after mount so a user toggling their system
  // dark mode while pref="system" sees the bridge re-render.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => setSystem(mq.matches ? "light" : "dark");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const resolved: ThemeResolved = pref === "system" ? system : pref;

  // Apply the resolved theme on every change. Skipped before mount so
  // we don't clobber whatever the no-flash script set during the first
  // paint (which already matches the user's saved preference).
  useEffect(() => {
    if (!mounted) return;
    applyDom(resolved);
  }, [mounted, resolved]);

  // Cross-tab sync: another tab's pref change mirrors here.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      const v = e.newValue;
      if (v === "dark" || v === "light" || v === "system") setPrefState(v);
      else if (v === null) setPrefState("system");
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setPref = useCallback((p: ThemePref) => {
    setPrefState(p);
    try {
      if (p === "system") window.localStorage.removeItem(STORAGE_KEY);
      else window.localStorage.setItem(STORAGE_KEY, p);
    } catch { /* ignore */ }
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
