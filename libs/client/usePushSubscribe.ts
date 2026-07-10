"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
// Type-only import (erased at compile time — no server-only `web-push`
// code reaches the client bundle). Must be explicit: without it, the
// name resolves to lib.dom's ambient `PushSubscriptionJSON` global,
// whose fields are ALL optional — the old `as PushSubscriptionJSON`
// cast typechecked even for an empty object and hid the mismatch with
// the strict server contract in `libs/webPush.ts`.
import type { PushSubscriptionJSON } from "../webPush";

/**
 * Narrow the browser's `PushSubscription.toJSON()` result (lib.dom
 * types every field optional) into the strict shape the bridge API
 * requires. In practice a successful `pushManager.subscribe()` always
 * yields endpoint + p256dh + auth, but the type system is right that
 * the contract doesn't guarantee it — so validate at runtime instead
 * of casting the doubt away.
 */
function toStrictSubscription(sub: PushSubscription): PushSubscriptionJSON {
  const json = sub.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!json.endpoint || !p256dh || !auth) {
    throw new Error("browser returned an incomplete push subscription");
  }
  return {
    endpoint: json.endpoint,
    expirationTime: json.expirationTime ?? null,
    keys: { p256dh, auth },
  };
}

/**
 * Task 9: browser Web Push opt-in. Mirrors the server-side flow in
 * `libs/webPush.ts` — register the no-cache service worker
 * (`public/sw.js`), ask for Notification permission, subscribe via
 * `PushManager` with the bridge's VAPID public key, and POST the
 * resulting subscription to `/api/push/subscribe` so
 * `sendPushToAll` can reach this browser.
 *
 *   - "unsupported" — no Push API / Notification API in this browser
 *     (e.g. Safari on old iOS, or a non-secure origin).
 *   - "denied"      — the user (or a prior visit) declined the browser
 *     permission prompt. Browsers don't let JS re-prompt once denied;
 *     the operator has to fix this from the browser's site settings.
 *   - "default"     — supported, not yet subscribed, permission not
 *     yet decided (or previously granted-but-unsubscribed).
 *   - "subscribed"  — an active `PushSubscription` exists for this SW
 *     registration.
 */
export type PushSubscribeState = "unsupported" | "default" | "denied" | "subscribed";

/** VAPID public keys arrive base64url-encoded; `PushManager.subscribe` wants raw bytes. */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const output = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) output[i] = rawData.charCodeAt(i);
  return output;
}

function isSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export function usePushSubscribe() {
  // Lazy initializer so the "unsupported" case never needs a
  // synchronous `setState` from inside the effect below (React flags
  // that as a cascading-render smell) — it's known at mount time from
  // a pure feature check, not from anything the effect subscribes to.
  const [state, setState] = useState<PushSubscribeState>(() =>
    isSupported() ? "default" : "unsupported",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supported = isSupported();

  // On mount: register the SW (idempotent — the browser reuses an
  // already-registered worker at the same scope) and reflect whatever
  // subscription/permission state already exists, so a returning
  // visitor sees "subscribed" instead of the button flashing "default".
  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    void (async () => {
      try {
        const reg = await navigator.serviceWorker.register("/sw.js");
        const existing = await reg.pushManager.getSubscription();
        if (cancelled) return;
        if (existing) {
          setState("subscribed");
        } else {
          setState(Notification.permission === "denied" ? "denied" : "default");
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supported]);

  const subscribe = useCallback(async () => {
    if (!supported) return;
    setBusy(true);
    setError(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState("denied");
        return;
      }
      const reg = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const { publicKey } = await api.pushVapidKey();
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        // TS's DOM lib types `Uint8Array` generically over its backing
        // buffer since ~5.7; `applicationServerKey` only cares that this
        // is a `BufferSource` at runtime, so a narrow cast here is safe.
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      });
      await api.pushSubscribe(toStrictSubscription(sub));
      setState("subscribed");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [supported]);

  const unsubscribe = useCallback(async () => {
    if (!supported) return;
    setBusy(true);
    setError(null);
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        // Best-effort: tell the server first so a mid-flight failure
        // leaves the browser subscribed rather than silently orphaning
        // a subscription the server no longer knows about.
        await api.pushUnsubscribe(sub.endpoint);
        await sub.unsubscribe();
      }
      setState("default");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [supported]);

  return { state, busy, error, supported, subscribe, unsubscribe };
}
