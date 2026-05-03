/**
 * Stub partials store. The Next-era SessionLog wired up token-streaming
 * partials over SSE so the user saw assistant text appear word-by-word
 * before the canonical .jsonl line landed. The Go bridge plumbing for
 * that stream isn't ported yet — when it is, this module is the seam.
 *
 * For now we expose the same surface so callers don't need to feature-
 * flag, but every method is a no-op. Once SSE partials are wired up,
 * swap this module for the real `useSyncExternalStore`-backed
 * implementation from main (`app/_components/SessionLog/partialsStore.ts`).
 *
 * The wiring point in views.tsx is `StreamingAssistantRow`; in index.tsx
 * it's the `<EmptyOrStreaming>` placeholder + `<StreamingPartialsList>`
 * mounted below the canonical rows. Both are intentionally absent here
 * because rendering them against a no-op store would cost re-renders
 * for zero visible benefit.
 */

export function appendPartial(
  _sessionId: string,
  _messageId: string,
  _text: string,
): void {
  // no-op
}

export function dropOnArrival(
  _sessionId: string,
  _arrivedIds: Iterable<string>,
): void {
  // no-op
}

export function clearPartials(_sessionId: string): void {
  // no-op
}

export function __resetPartialsStoreForTests(): void {
  // no-op
}
