/**
 * Web Push notifications — server-only.
 *
 * Task 9 companion to `libs/telegramNotifier.ts`: instead of (or
 * alongside) a Telegram bot, the operator's browser can subscribe to
 * native OS push notifications via the Push API + a VAPID-signed
 * `web-push` payload. No third-party service required — the bridge
 * itself is the push application server.
 *
 * State on disk (both under `BRIDGE_STATE_DIR`, mode 0600 like
 * `libs/setupToken.ts`'s token file — one holds a private key, the
 * other holds subscriber endpoints, neither should be world-readable):
 *
 *   - `push-keys.json` — `{ publicKey, privateKey }` VAPID key pair,
 *     generated once on first use and persisted forever after (rotating
 *     it would silently invalidate every existing browser subscription).
 *   - `push-subs.json` — array of `{ endpoint, keys, expirationTime,
 *     addedAt }`, one entry per browser that granted permission.
 *
 * Every exported function is best-effort: this module is a fan-out
 * *addition* beside the existing Telegram notifier, never a dependency
 * the rest of the bridge can break on. `sendPushToAll` in particular
 * never rejects — a dead push endpoint, a corrupt subscriber file, or
 * `web-push` throwing synchronously all degrade to a console warning.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import * as webpush from "web-push";
import { BRIDGE_STATE_DIR } from "./paths";

const KEYS_FILE = join(BRIDGE_STATE_DIR, "push-keys.json");
const SUBS_FILE = join(BRIDGE_STATE_DIR, "push-subs.json");

/**
 * VAPID requires a contact URL/email in the `subject` field so a push
 * service operator can reach out if a sender misbehaves. We don't have
 * a great per-install value to use (the bridge has no notion of "the
 * operator's email" outside of auth config, and importing `libs/auth`
 * here would pull the whole auth module into every push send for a
 * cosmetic header field) — a fixed placeholder is what most self-hosted
 * `web-push` setups ship with and push services don't validate it.
 */
const VAPID_SUBJECT = "mailto:push@claude-bridge.local";

export interface PushSubscriptionKeys {
  p256dh: string;
  auth: string;
}

/** Shape of `PushSubscription.toJSON()` in the browser. */
export interface PushSubscriptionJSON {
  endpoint: string;
  expirationTime?: number | null;
  keys: PushSubscriptionKeys;
}

interface StoredSubscription {
  endpoint: string;
  expirationTime: number | null;
  keys: PushSubscriptionKeys;
  addedAt: string;
}

interface VapidKeyPair {
  publicKey: string;
  privateKey: string;
}

function ensureParentDir(path: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // Best-effort — writeFileSync below surfaces any real error.
  }
}

/** Write JSON to `path`, chmod 0600 on POSIX — mirrors `setupToken.ts`. */
function writeSecureJson(path: string, value: unknown): void {
  ensureParentDir(path);
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
  if (process.platform !== "win32") {
    try {
      chmodSync(path, 0o600);
    } catch {
      // Best-effort — Windows doesn't honor POSIX modes, and a POSIX
      // chmod failure just means the filesystem doesn't support it.
    }
  }
}

function isVapidKeyPair(v: unknown): v is VapidKeyPair {
  const o = v as Partial<VapidKeyPair> | null;
  return (
    !!o &&
    typeof o === "object" &&
    typeof o.publicKey === "string" &&
    o.publicKey.length > 0 &&
    typeof o.privateKey === "string" &&
    o.privateKey.length > 0
  );
}

/**
 * Read the persisted VAPID key pair, generating + persisting a fresh
 * one on first use. Re-reads from disk on every call (no module-scope
 * cache) so a dev HMR reload always sees the on-disk value rather than
 * a stale in-memory pair from a previous module instance.
 */
function loadOrCreateVapidKeys(): VapidKeyPair {
  if (existsSync(KEYS_FILE)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(KEYS_FILE, "utf8"));
      if (isVapidKeyPair(parsed)) return parsed;
    } catch {
      // Corrupt / unreadable — fall through and regenerate below.
    }
  }
  const keys = webpush.generateVAPIDKeys();
  writeSecureJson(KEYS_FILE, keys);
  return keys;
}

/**
 * Public counterpart of `loadOrCreateVapidKeys` — returns ONLY the
 * public key, safe to expose from `GET /api/push/vapid` to any
 * authenticated browser so it can build a `PushManager.subscribe`
 * call.
 */
export function ensureVapidKeys(): { publicKey: string } {
  return { publicKey: loadOrCreateVapidKeys().publicKey };
}

function isStoredSubscriptionShape(v: unknown): v is StoredSubscription {
  const o = v as Partial<StoredSubscription> | null;
  return (
    !!o &&
    typeof o === "object" &&
    typeof o.endpoint === "string" &&
    o.endpoint.length > 0 &&
    !!o.keys &&
    typeof o.keys.p256dh === "string" &&
    typeof o.keys.auth === "string"
  );
}

function readSubscriptions(): StoredSubscription[] {
  if (!existsSync(SUBS_FILE)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(SUBS_FILE, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isStoredSubscriptionShape);
  } catch {
    return [];
  }
}

function writeSubscriptions(subs: StoredSubscription[]): void {
  writeSecureJson(SUBS_FILE, subs);
}

/**
 * Register a browser push subscription. Idempotent on `endpoint` — a
 * re-subscribe (e.g. the service worker rotating keys) overwrites the
 * stored entry instead of accumulating a duplicate. Silently ignores
 * malformed input (missing endpoint / keys) rather than throwing, since
 * this is called directly from an API route body the client controls.
 */
export function addSubscription(sub: PushSubscriptionJSON): void {
  if (
    !sub ||
    typeof sub.endpoint !== "string" ||
    !sub.endpoint ||
    !sub.keys ||
    typeof sub.keys.p256dh !== "string" ||
    typeof sub.keys.auth !== "string"
  ) {
    return;
  }
  const subs = readSubscriptions().filter((s) => s.endpoint !== sub.endpoint);
  subs.push({
    endpoint: sub.endpoint,
    expirationTime:
      typeof sub.expirationTime === "number" ? sub.expirationTime : null,
    keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    addedAt: new Date().toISOString(),
  });
  writeSubscriptions(subs);
}

/** Remove a subscription by endpoint. No-op if it wasn't subscribed. */
export function removeSubscription(endpoint: string): void {
  if (!endpoint) return;
  const subs = readSubscriptions();
  const next = subs.filter((s) => s.endpoint !== endpoint);
  if (next.length !== subs.length) writeSubscriptions(next);
}

/** Current subscriber count — cheap enough for a settings-page badge. */
export function subscriptionCount(): number {
  return readSubscriptions().length;
}

/**
 * Fan out a notification to every subscribed browser. Best-effort in
 * every dimension the fan-out call sites in `telegramNotifier.ts` rely
 * on:
 *
 *   - No-ops instantly (never touches `web-push`) when there are zero
 *     subscribers — the common case on a fresh install.
 *   - Per-subscriber failures are caught individually; one dead
 *     endpoint never blocks delivery to the others.
 *   - A 404/410 response means the push service (or the browser) has
 *     permanently invalidated that subscription — it's pruned from
 *     disk so future sends don't keep retrying a dead endpoint.
 *   - The whole function is wrapped in a top-level try/catch so even a
 *     synchronous throw (e.g. `web-push` rejecting a malformed VAPID
 *     key) resolves rather than rejects — callers can fire-and-forget
 *     this without a `.catch()`.
 */
export async function sendPushToAll(payload: {
  title: string;
  body: string;
  url?: string;
}): Promise<void> {
  try {
    const subs = readSubscriptions();
    if (subs.length === 0) return;

    const { publicKey, privateKey } = loadOrCreateVapidKeys();
    webpush.setVapidDetails(VAPID_SUBJECT, publicKey, privateKey);

    const json = JSON.stringify(payload);
    const dead: string[] = [];
    await Promise.all(
      subs.map(async (sub) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: sub.endpoint,
              expirationTime: sub.expirationTime,
              keys: sub.keys,
            },
            json,
          );
        } catch (err) {
          const statusCode = (err as { statusCode?: number } | undefined)
            ?.statusCode;
          if (statusCode === 404 || statusCode === 410) {
            dead.push(sub.endpoint);
          } else {
            console.warn(
              `[webpush] send failed for ${sub.endpoint.slice(0, 60)}…:`,
              (err as Error)?.message ?? err,
            );
          }
        }
      }),
    );

    if (dead.length > 0) {
      const remaining = readSubscriptions().filter(
        (s) => !dead.includes(s.endpoint),
      );
      writeSubscriptions(remaining);
    }
  } catch (err) {
    console.warn(
      "[webpush] sendPushToAll failed:",
      (err as Error)?.message ?? err,
    );
  }
}
