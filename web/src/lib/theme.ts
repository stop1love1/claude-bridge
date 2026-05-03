// Pure theme resolution — kept out of the Provider so unit tests can
// poke at it without React. `pref` is the user's saved preference
// (`light` | `dark` | `system`); `resolved` is the concrete value
// applied to the DOM (`light` | `dark`).
//
// The SPA's editorial aesthetic is dark-first. `system` follows the
// OS via prefers-color-scheme so a user on a light desktop still sees
// our intended visual hierarchy unless they explicitly opt into light.

export type ThemePref = "light" | "dark" | "system";
export type ThemeResolved = "light" | "dark";

export const STORAGE_KEY = "bridge.theme";

export function resolveTheme(pref: ThemePref, systemIsLight: boolean): ThemeResolved {
  if (pref === "light") return "light";
  if (pref === "dark") return "dark";
  return systemIsLight ? "light" : "dark";
}

export function readPref(): ThemePref {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* localStorage may be blocked in private mode */
  }
  return "system";
}

export function writePref(pref: ThemePref): void {
  try {
    if (pref === "system") window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    /* ignore */
  }
}

/** Apply a resolved theme to the document. Idempotent.
 *
 * The palette is keyed off `data-theme` (matches the main branch's
 * shadcn-token CSS). The `dark` class is also kept in sync because
 * Tailwind's `darkMode: ["selector", ':root[data-theme="dark"]']`
 * resolves either way — but an older session that wrote `class="dark"`
 * shouldn't drift, so we strip it cleanly each apply. */
export function applyTheme(resolved: ThemeResolved): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  // Remove any stale class-based marker from a previous build.
  root.classList.remove("dark");
  root.style.colorScheme = resolved;
  root.setAttribute("data-theme", resolved);
}
