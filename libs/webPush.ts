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

const VAPID_SUBJECT = "mailto:push@claude-bridge.local";

export interface PushSubscriptionKeys {
  p256dh: string;
  auth: string;
}

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
  }
}

function writeSecureJson(path: string, value: unknown): void {
  ensureParentDir(path);
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
  if (process.platform !== "win32") {
    try {
      chmodSync(path, 0o600);
    } catch {
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

function loadOrCreateVapidKeys(): VapidKeyPair {
  if (existsSync(KEYS_FILE)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(KEYS_FILE, "utf8"));
      if (isVapidKeyPair(parsed)) return parsed;
    } catch {
    }
  }
  const keys = webpush.generateVAPIDKeys();
  writeSecureJson(KEYS_FILE, keys);
  return keys;
}

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

export function removeSubscription(endpoint: string): void {
  if (!endpoint) return;
  const subs = readSubscriptions();
  const next = subs.filter((s) => s.endpoint !== endpoint);
  if (next.length !== subs.length) writeSubscriptions(next);
}

export function subscriptionCount(): number {
  return readSubscriptions().length;
}

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
