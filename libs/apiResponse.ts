import { NextResponse } from "next/server";

/**
 * Canonical success-response helpers for `app/api/**` routes.
 *
 * The bridge's API has historically mixed three patterns for success
 * payloads:
 *
 *   - `NextResponse.json({ ok: true })` — the typical no-content ack
 *     (DELETE, kill, link, permission answer)
 *   - `NextResponse.json({ tunnel: ... })` / `NextResponse.json({ tasks })`
 *     — the typical has-data response, payload as the top-level object
 *   - `NextResponse.json({ ok: true, sessionId, action: "killed" })` —
 *     the in-between case where a route appended payload fields onto a
 *     short-circuit `{ ok: true }` for "this also returns a bit of data
 *     about what happened"
 *
 * The third shape is the inconsistency the helpers below normalize away.
 *
 * Conventions:
 *
 *   - **Success with data** — return the payload object directly:
 *     `return ok({ tunnel, tasks })`. Callers `JSON.parse` and read
 *     fields off the top-level object as before.
 *   - **No-content success** (DELETE, kill, link, permission answer):
 *     `return ok()`. Body is `{ ok: true }` so existing fetchers checking
 *     `body.ok === true` keep working.
 *   - **Errors** — use `serverError()` / `safeErrorMessage()` from
 *     `libs/errorResponse.ts`. The body is always `{ error: string }`,
 *     never `{ ok: false }`.
 *
 * The third shape (`{ ok: true, ...data }`) is deprecated. New routes
 * should split: either there's data (use `ok(payload)`) or there isn't
 * (use `ok()`).
 */

const OK_BODY = { ok: true } as const;

export function ok(): NextResponse;
export function ok<T>(payload: T): NextResponse;
export function ok<T>(payload?: T): NextResponse {
  if (payload === undefined) return NextResponse.json(OK_BODY);
  return NextResponse.json(payload);
}
