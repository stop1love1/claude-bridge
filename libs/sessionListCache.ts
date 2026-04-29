/**
 * Tiny shared cache-bust hook for `/api/sessions/all`.
 *
 * The list endpoint caches its full response for ~2 s and invalidates
 * automatically on every `meta:changed` event. That covers spawn / link /
 * task-section moves, but NOT orphan-session changes (free chats that
 * never write meta) — deleting an orphan removed the .jsonl from disk
 * but the next poll still served the stale cached row, so the UI
 * looked like delete had no effect. Routes that mutate raw session
 * files import `bustSessionsListCache()` and call it after success.
 *
 * Stored on `globalThis` so it survives Next.js dev-server module
 * reloads — same pattern as `__bridgeMetaEvents` in `libs/meta.ts`.
 */
type Bust = () => void;
const G = globalThis as unknown as { __bridgeBustSessionsAll?: Bust };

export function setSessionsListBuster(fn: Bust): void {
  G.__bridgeBustSessionsAll = fn;
}

export function bustSessionsListCache(): void {
  G.__bridgeBustSessionsAll?.();
}
