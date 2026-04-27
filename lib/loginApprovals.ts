/**
 * In-memory store for pending device-login approvals.
 *
 * Flow (paired with `app/api/auth/login` + `app/api/auth/approvals`):
 *
 *   1. A NEW device (no trusted-device cookie) submits valid email +
 *      password to `POST /api/auth/login`.
 *   2. Login route sees ≥ 1 active trusted device exists → instead of
 *      signing a cookie, it creates a `PendingLogin` here and returns
 *      `202 { status: "pending", pendingId }`.
 *   3. The new device polls `GET /api/auth/login/pending/<pendingId>`
 *      every ~2s until the existing trusted device approves or denies.
 *   4. The existing trusted device polls
 *      `GET /api/auth/approvals` (UI mounts a polling hook in the
 *      header shell), sees the pending entry, shows a modal with the
 *      requesting device's UA + IP + timestamp.
 *   5. Operator clicks Approve / Deny → `POST /api/auth/approvals/<id>`
 *      with `{ decision }`. Server marks the entry.
 *   6. New device's next poll returns `{ status: "approved", ... }`
 *      with the cookie attached on the SAME response, then redirects
 *      to `/`. (`denied` → 403 with reason.)
 *
 * Bootstrap exception: when there are no trusted devices yet (fresh
 * install or post-reset), the login route skips the approval gate and
 * signs the cookie directly — otherwise the FIRST login would be
 * impossible.
 *
 * The store is module-level + HMR-safe (same `globalThis` stash trick
 * used by `permissionStore` / `spawnRegistry`). Entries auto-expire
 * after 3 minutes; both the new device's poll and the operator's
 * approval respect the expiry.
 */

import { randomBytes } from "node:crypto";

export interface PendingLogin {
  id: string;
  email: string;
  /** Whether the new device asked to be remembered (30-day cookie). */
  trust: boolean;
  /** Friendly device label derived from the user-agent at request time. */
  deviceLabel: string;
  /** Best-effort remote address — `127.0.0.1` for loopback. */
  remoteIp: string;
  /** Raw UA string for the approval modal — operator can inspect it. */
  userAgent: string;
  /** ISO timestamp the new device hit /login. */
  createdAt: string;
  /** Epoch ms after which the entry is treated as expired (~3 min). */
  expiresAt: number;
  status: "pending" | "approved" | "denied";
  /** Optional reason when denied. */
  reason?: string;
}

interface Store {
  pending: Map<string, PendingLogin>;
}

const G = globalThis as unknown as { __bridgeLoginApprovals?: Store };
const store: Store =
  G.__bridgeLoginApprovals ?? { pending: new Map<string, PendingLogin>() };
G.__bridgeLoginApprovals = store;

/** TTL for an unanswered approval — 3 minutes. */
export const APPROVAL_TTL_MS = 3 * 60 * 1000;

function now(): number {
  return Date.now();
}

function newId(): string {
  // 16-char hex — collision-safe enough for in-memory store with
  // 3-minute lifetimes; short enough for compact URL paths.
  return randomBytes(8).toString("hex");
}

function pruneExpired(): void {
  const t = now();
  for (const [id, entry] of store.pending) {
    // Drop expired entries that were never answered AND answered
    // entries older than 5 minutes (give the new device's polling
    // enough time to see the final state before we GC).
    if (entry.status === "pending" && entry.expiresAt <= t) {
      store.pending.delete(id);
      continue;
    }
    if (entry.status !== "pending" && entry.expiresAt + 2 * 60 * 1000 <= t) {
      store.pending.delete(id);
    }
  }
}

/**
 * Create a pending-login entry. Returns the new record so the login
 * route can include `id` + `expiresAt` in its 202 response.
 */
export function createPendingLogin(args: {
  email: string;
  trust: boolean;
  deviceLabel: string;
  remoteIp: string;
  userAgent: string;
}): PendingLogin {
  pruneExpired();
  const t = now();
  const entry: PendingLogin = {
    id: newId(),
    email: args.email,
    trust: args.trust,
    deviceLabel: args.deviceLabel,
    remoteIp: args.remoteIp,
    userAgent: args.userAgent,
    createdAt: new Date(t).toISOString(),
    expiresAt: t + APPROVAL_TTL_MS,
    status: "pending",
  };
  store.pending.set(entry.id, entry);
  return entry;
}

/**
 * Look up by id. Returns the entry even when `status !== "pending"`
 * so the new device's poll can read the final state (and the route
 * can `consume` it on read).
 */
export function getPendingLogin(id: string): PendingLogin | null {
  pruneExpired();
  return store.pending.get(id) ?? null;
}

/**
 * Mark an entry approved or denied. Returns the updated record, or
 * null if the entry doesn't exist / already expired. Always pruning
 * expired entries first means the operator can't approve a request
 * the new device has already given up on.
 */
export function answerPendingLogin(
  id: string,
  decision: "approved" | "denied",
  reason?: string,
): PendingLogin | null {
  pruneExpired();
  const entry = store.pending.get(id);
  if (!entry) return null;
  if (entry.status !== "pending") return entry; // already answered
  entry.status = decision;
  if (reason) entry.reason = reason.slice(0, 200);
  store.pending.set(id, entry);
  return entry;
}

/**
 * Drop an entry from the store — called by the new device's poll
 * route after delivering the final state, so the map doesn't leak
 * answered entries forever.
 */
export function consumePendingLogin(id: string): void {
  store.pending.delete(id);
}

/**
 * List currently-pending requests. Used by the operator's UI poll
 * (`GET /api/auth/approvals`) to populate the modal queue.
 */
export function listPendingLogins(): PendingLogin[] {
  pruneExpired();
  const out: PendingLogin[] = [];
  for (const entry of store.pending.values()) {
    if (entry.status === "pending") out.push(entry);
  }
  // Newest first so the modal shows the most recent attempt at top.
  out.sort((a, b) => b.expiresAt - a.expiresAt);
  return out;
}
