import { verifyRequestAuth } from "./auth";
import { consumePtyWsTicket } from "./ptyWsTickets";

/** Minimal cookie-jar shape `verifyRequestAuth` expects, built from a raw `Cookie:` header. */
function cookiesFromHeader(header: string | undefined): {
  get(name: string): { value: string } | undefined;
} {
  const map = new Map<string, string>();
  if (header) {
    for (const part of header.split(";")) {
      const idx = part.indexOf("=");
      if (idx === -1) continue;
      const k = part.slice(0, idx).trim();
      let v = part.slice(idx + 1).trim();
      try {
        v = decodeURIComponent(v);
      } catch {
        /* keep raw */
      }
      if (k) map.set(k, v);
    }
  }
  return {
    get(name: string) {
      const v = map.get(name);
      return v !== undefined ? { value: v } : undefined;
    },
  };
}

export interface PtyUpgradeAuthInput {
  cookieHeader: string | undefined;
  /**
   * Accepted for shape parity with the raw upgrade request only —
   * see the header comment on `authorizePtyUpgrade` below for why it
   * is never read.
   */
  internalTokenHeader: string | undefined;
  ticket: string | undefined;
}

export type PtyUpgradeAuthResult =
  | { ok: true; sub: string }
  | { ok: false; reason: string };

/**
 * Authorize a PTY WebSocket upgrade.
 *
 * Deliberately does NOT honour `x-bridge-internal-token`. Every other
 * consumer of that bypass sits behind `proxy.ts`'s same-host gate; the
 * raw `server.on("upgrade")` listener bypasses Next middleware entirely,
 * so the token alone would hand any holder an interactive shell — and
 * the token lives in the env of every spawned child (audit C5).
 *
 * Header-less clients (browsers) already use the one-time ticket path;
 * automation should mint a ticket via POST /api/apps/pty-ws-ticket too.
 */
export function authorizePtyUpgrade(args: PtyUpgradeAuthInput): PtyUpgradeAuthResult {
  const cookieAuthed = verifyRequestAuth({ cookies: cookiesFromHeader(args.cookieHeader) });
  if (cookieAuthed) return { ok: true, sub: cookieAuthed.sub };

  const consumed = consumePtyWsTicket(args.ticket);
  if (consumed.ok) return { ok: true, sub: consumed.sub };

  return { ok: false, reason: "no valid session cookie or one-time ticket" };
}
