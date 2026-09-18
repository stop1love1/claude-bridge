/**
 * Short random-ID generator for collision-avoidance (temp filenames, branch
 * suffixes, optimistic UI IDs). Not for security. Uses `crypto.getRandomValues`
 * — better distribution than `Math.random()` — and emits URL-safe base64url.
 */
export function shortId(bytes = 3): string {
  // 3 bytes → 4 chars (matches `Math.random().toString(36).slice(2, 6)` length)
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");
}
