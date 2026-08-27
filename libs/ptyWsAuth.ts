import { verifyRequestAuth } from "./auth";
import { consumePtyWsTicket } from "./ptyWsTickets";

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
  internalTokenHeader: string | undefined;
  ticket: string | undefined;
}

export type PtyUpgradeAuthResult =
  | { ok: true; sub: string }
  | { ok: false; reason: string };

export function authorizePtyUpgrade(args: PtyUpgradeAuthInput): PtyUpgradeAuthResult {
  const cookieAuthed = verifyRequestAuth({ cookies: cookiesFromHeader(args.cookieHeader) });
  if (cookieAuthed) return { ok: true, sub: cookieAuthed.sub };

  const consumed = consumePtyWsTicket(args.ticket);
  if (consumed.ok) return { ok: true, sub: consumed.sub };

  return { ok: false, reason: "no valid session cookie or one-time ticket" };
}
