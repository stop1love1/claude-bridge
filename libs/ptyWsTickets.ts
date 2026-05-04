import { randomBytes } from "node:crypto";

/** One-shot WebSocket PTY tickets — minted over cookie-authenticated HTTP, consumed on upgrade. */
type Entry = { exp: number; sub: string };
const store = new Map<string, Entry>();
const TTL_MS = 60_000;
const MAX_ENTRIES = 500;

function prune(): void {
  const now = Date.now();
  for (const [k, v] of store) {
    if (v.exp <= now) store.delete(k);
  }
}

export function mintPtyWsTicket(sub: string): string {
  prune();
  if (store.size > MAX_ENTRIES) {
    const sorted = [...store.entries()].sort((a, b) => a[1].exp - b[1].exp);
    for (const [k] of sorted.slice(0, Math.floor(MAX_ENTRIES / 2))) store.delete(k);
  }
  const id = randomBytes(32).toString("base64url");
  store.set(id, { exp: Date.now() + TTL_MS, sub });
  return id;
}

export function consumePtyWsTicket(id: string | undefined | null): { ok: true; sub: string } | { ok: false } {
  if (!id || typeof id !== "string" || id.length > 256) return { ok: false };
  prune();
  const e = store.get(id);
  if (!e || e.exp < Date.now()) {
    if (e) store.delete(id);
    return { ok: false };
  }
  store.delete(id);
  return { ok: true, sub: e.sub };
}
