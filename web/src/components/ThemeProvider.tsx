// Theme context for the SPA. Default = dark (matches our base CSS).
// We use `useSyncExternalStore` so the resolved snapshot is always in
// sync with localStorage + the OS prefers-color-scheme media query
// without an effect ladder.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import {
  applyTheme,
  readPref,
  resolveTheme,
  STORAGE_KEY,
  writePref,
  type ThemePref,
  type ThemeResolved,
} from "@/lib/theme";

interface ThemeCtx {
  pref: ThemePref;
  resolved: ThemeResolved;
  setPref: (p: ThemePref) => void;
  /** True after first client mount — lets consumers skip SSR-style placeholders. */
  mounted: boolean;
}

const Ctx = createContext<ThemeCtx | null>(null);

// ---- external-store adapters ---------------------------------------

function subscribePref(cb: () => void) {
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY || e.key === null) cb();
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}

function subscribeSystem(cb: () => void) {
  const mq = window.matchMedia("(prefers-color-scheme: light)");
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}
function getSystemSnapshot(): boolean {
  return window.matchMedia("(prefers-color-scheme: light)").matches;
}

function noopSubscribe() { return () => {}; }
const getMountedClient = () => true;
const getMountedServer = () => false;

// --------------------------------------------------------------------

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // SSR snapshot is "system" / dark — matches the no-flash assumption.
  const pref = useSyncExternalStore<ThemePref>(
    subscribePref,
    readPref,
    () => "system",
  );
  const systemIsLight = useSyncExternalStore<boolean>(
    subscribeSystem,
    getSystemSnapshot,
    () => false,
  );
  const mounted = useSyncExternalStore<boolean>(
    noopSubscribe,
    getMountedClient,
    getMountedServer,
  );

  const resolved = resolveTheme(pref, systemIsLight);

  // Apply to DOM whenever the resolved theme changes (skipped pre-mount
  // so we don't undo whatever index.html shipped with).
  useEffect(() => {
    if (!mounted) return;
    applyTheme(resolved);
  }, [mounted, resolved]);

  const setPref = useCallback((p: ThemePref) => {
    writePref(p);
    // Storage events only fire across tabs, so nudge the in-tab
    // subscribers ourselves.
    try {
      window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
    } catch {
      /* older browsers */
    }
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

export type { ThemePref, ThemeResolved };
