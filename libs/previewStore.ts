/**
 * Live App Preview (Epic C) — per-app preview URL store. Backed by
 * `.bridge-state/previews.json` (`{ [appName]: { url } }`). The operator
 * sets a reachable URL of the running app; the bridge embeds it in an
 * iframe on the task / share page. Same globalThis + atomic-write pattern
 * as the other bridge-state stores.
 * See docs/superpowers/specs/2026-06-04-live-preview-design.md.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BRIDGE_STATE_DIR } from "./paths";
import { writeJsonAtomic } from "./atomicWrite";

const PREVIEWS_FILE = join(BRIDGE_STATE_DIR, "previews.json");

interface PreviewEntry {
  url: string;
}
interface StoreShape {
  previews: Record<string, PreviewEntry>;
}
interface State {
  data: StoreShape;
  loaded: boolean;
}

const G = globalThis as unknown as { __bridgePreviewStore?: State };
const state: State =
  G.__bridgePreviewStore ?? (G.__bridgePreviewStore = { data: { previews: {} }, loaded: false });

function load(): void {
  if (state.loaded) return;
  try {
    if (existsSync(PREVIEWS_FILE)) {
      const parsed = JSON.parse(readFileSync(PREVIEWS_FILE, "utf8")) as Partial<StoreShape>;
      state.data = { previews: parsed.previews && typeof parsed.previews === "object" ? parsed.previews : {} };
    }
  } catch {
    state.data = { previews: {} };
  }
  state.loaded = true;
}

function persist(): void {
  writeJsonAtomic(PREVIEWS_FILE, state.data);
}

/** Only http(s) URLs may be embedded — blocks `javascript:` / `data:` injection. */
export function isValidPreviewUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    // eslint-disable-next-line no-new
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

export function getPreviewUrl(appName: string): string | null {
  load();
  return state.data.previews[appName]?.url ?? null;
}

/**
 * Set (or clear, on empty) the preview URL for an app. Returns the stored
 * URL (or null when cleared), or throws on an invalid non-empty URL.
 */
export function setPreviewUrl(appName: string, url: string | null): string | null {
  load();
  const trimmed = (url ?? "").trim();
  if (!trimmed) {
    delete state.data.previews[appName];
    persist();
    return null;
  }
  if (!isValidPreviewUrl(trimmed)) {
    throw new Error("preview URL must be http:// or https://");
  }
  state.data.previews[appName] = { url: trimmed.slice(0, 2000) };
  persist();
  return state.data.previews[appName].url;
}

export function listPreviews(): Record<string, string> {
  load();
  return Object.fromEntries(Object.entries(state.data.previews).map(([k, v]) => [k, v.url]));
}

/** Test-only: reset the in-memory store without touching disk. */
export function _resetForTests(): void {
  state.data = { previews: {} };
  state.loaded = true;
}

export const _internal = { PREVIEWS_FILE };
