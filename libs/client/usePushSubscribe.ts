"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { api } from "./api";
import type { PushSubscriptionJSON } from "../webPush";

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
 * `checking` is what both the server render and the browser's *first* render
 * produce.
 *
 * Everything else here is derived from browser-only globals (`navigator`,
 * `window.PushManager`, `Notification.permission`). Seeding `useState` from
 * them meant the server rendered "Not supported in this browser" — no `window`
 * during SSR — while hydration rendered "Not enabled on this device" with a
 * different button, which is exactly the `Hydration failed` React logs on
 * every `/settings` load. Feature detection has to happen in an effect, after
 * the first render has already matched.
 */
export type PushSubscribeState =
  | "checking"
  | "unsupported"
  | "default"
  | "denied"
  | "subscribed";

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

/** Feature support never changes for the life of the page. */
const subscribeToNothing = () => () => {};

/**
 * The rendered state, given what we know about the browser.
 *
 * Extracted so the hydration invariant is assertable without a DOM: the server
 * and the hydrating client both see `supported === null` (there is no
 * `window` on the server, and `useSyncExternalStore` hands the same server
 * snapshot to the first client render), so both must produce the same string.
 * Seeding this from `isSupported()` instead is what made the server render
 * "Not supported in this browser" against the client's "Not enabled on this
 * device" — two different trees, one `Hydration failed`.
 */
export function derivePushState(
  supported: boolean | null,
  probed: PushSubscribeState | null,
): PushSubscribeState {
  if (supported === null) return "checking";
  if (!supported) return "unsupported";
  return probed ?? "checking";
}

export function usePushSubscribe() {
  /**
   * `useSyncExternalStore` rather than `useState(isSupported())`: it is the
   * one API that lets the server and the hydrating client agree on `null`
   * while the settled client render gets the real answer, without React
   * comparing two different trees.
   */
  const supported = useSyncExternalStore<boolean | null>(
    subscribeToNothing,
    isSupported,
    () => null,
  );
  const [probed, setProbed] = useState<PushSubscribeState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const state = derivePushState(supported, probed);

  useEffect(() => {
    if (supported !== true) return;
    let cancelled = false;
    void (async () => {
      try {
        const reg = await navigator.serviceWorker.register("/sw.js");
        const existing = await reg.pushManager.getSubscription();
        if (cancelled) return;
        if (existing) {
          setProbed("subscribed");
        } else {
          setProbed(Notification.permission === "denied" ? "denied" : "default");
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
    if (supported !== true) return;
    setBusy(true);
    setError(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setProbed("denied");
        return;
      }
      const reg = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const { publicKey } = await api.pushVapidKey();
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      });
      await api.pushSubscribe(toStrictSubscription(sub));
      setProbed("subscribed");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [supported]);

  const unsubscribe = useCallback(async () => {
    if (supported !== true) return;
    setBusy(true);
    setError(null);
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await api.pushUnsubscribe(sub.endpoint);
        await sub.unsubscribe();
      }
      setProbed("default");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [supported]);

  return { state, busy, error, supported: supported === true, subscribe, unsubscribe };
}
