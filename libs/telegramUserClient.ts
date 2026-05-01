/**
 * Telegram MTProto user-client (gram-js).
 *
 * Pairs with the Bot API integration in `telegramNotifier.ts` /
 * `telegramCommands.ts`. The user-client logs in as the operator's
 * own Telegram account, which:
 *   - sidesteps Bot API limitations (no "bots can't send to bots"
 *     errors, no group-privacy restrictions, no 50MB upload cap)
 *   - keeps notifications + commands flowing even when the bot is
 *     restricted, banned, or hasn't been added to a chat
 *
 * The client is a lazy singleton — instantiated on first use, kept
 * alive across HMR via `globalThis`. Connection lifecycle:
 *
 *   getTelegramUserClient()  → reads bridge.json.telegram.user, builds
 *                              + connects a TelegramClient if creds
 *                              are valid; reuses the cached one on
 *                              subsequent calls.
 *   disconnectTelegramUserClient() → tears down the connection +
 *                              clears the cache. Called when settings
 *                              are saved (so a session-string swap
 *                              picks up the new auth).
 *
 * Login flow (one-time per session string) lives in
 * `scripts/telegram-login.ts` — this module assumes the StringSession
 * is already populated and refuses to run interactive auth here.
 */

import type { TelegramClient } from "telegram";
import { getManifestTelegramSettings } from "./apps";

interface UserClientState {
  /** Active client, cached after a successful connect. */
  client: TelegramClient | null;
  /**
   * Promise of an in-flight connect, so two concurrent callers don't
   * race to build two clients for the same session.
   */
  connecting: Promise<TelegramClient | null> | null;
  /**
   * Hash of the credentials the cached client was built with — used to
   * detect a settings change and rebuild on next request rather than
   * silently keep the stale connection alive.
   */
  credsHash: string;
  /**
   * Inbound message handlers attached via `addEventHandler`, paired
   * with the wrapped dispatcher we actually registered with gram-js.
   * Keeping the wrapper handle is what lets us call
   * `removeEventHandler` cleanly on unsubscribe — without it, gram-js's
   * internal listener list keeps the closure alive forever and a
   * settings-driven reconnect (which re-attaches new wrappers) silently
   * accumulates dispatchers across reload.
   */
  inboundHandlers: Map<InboundHandler, (event: unknown) => void>;
}

const G = globalThis as unknown as {
  __bridgeTelegramUserClient?: UserClientState;
};
const state: UserClientState =
  G.__bridgeTelegramUserClient ?? {
    client: null,
    connecting: null,
    credsHash: "",
    inboundHandlers: new Map(),
  };
G.__bridgeTelegramUserClient = state;

export interface InboundMessage {
  /** Numeric chat id (negative for groups/channels, positive for users). */
  chatId: string;
  /** Telegram message id (per-chat sequential). */
  messageId: number;
  /** Numeric sender id, or empty when the sender is hidden. */
  senderId: string;
  /** Plain-text body of the message. */
  text: string;
  /** True when the chat is a private 1-on-1 with the operator. */
  isPrivate: boolean;
}

export type InboundHandler = (msg: InboundMessage) => void | Promise<void>;

function credsFingerprint(): string {
  const s = getManifestTelegramSettings().user;
  // Don't include `targetChatId` — it can change without invalidating
  // the auth session. Hash bytes deliberately small (no crypto needed).
  return `${s.apiId}:${s.apiHash}:${s.session.length}:${s.session.slice(-12)}`;
}

/**
 * Returns true when bridge.json has the minimum credentials to attempt
 * a connect (apiId > 0 + apiHash + session non-empty). The actual
 * connect can still fail downstream if the session is revoked.
 */
export function isUserClientConfigured(): boolean {
  const s = getManifestTelegramSettings().user;
  return s.apiId > 0 && s.apiHash.length > 0 && s.session.length > 0;
}

/**
 * Lazy-load the gram-js library so importers of this module don't pay
 * its ~5MB cost when Telegram user-mode isn't configured. The dynamic
 * import is cached at module level on first hit.
 */
async function loadGramJs(): Promise<{
  TelegramClient: typeof import("telegram").TelegramClient;
  StringSession: typeof import("telegram/sessions").StringSession;
  Api: typeof import("telegram").Api;
  NewMessage: typeof import("telegram/events").NewMessage;
}> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const tg = require("telegram") as typeof import("telegram");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sessionsMod = require("telegram/sessions") as typeof import("telegram/sessions");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const eventsMod = require("telegram/events") as typeof import("telegram/events");
  return {
    TelegramClient: tg.TelegramClient,
    StringSession: sessionsMod.StringSession,
    Api: tg.Api,
    NewMessage: eventsMod.NewMessage,
  };
}

/**
 * Build + connect a TelegramClient. Throws when credentials are
 * invalid / session expired so the caller can surface a useful error
 * to the operator (the bot fallback path then takes over).
 */
async function buildAndConnect(): Promise<TelegramClient | null> {
  const settings = getManifestTelegramSettings().user;
  if (!isUserClientConfigured()) return null;

  const { TelegramClient, StringSession, NewMessage } = await loadGramJs();
  const session = new StringSession(settings.session);
  const client = new TelegramClient(session, settings.apiId, settings.apiHash, {
    connectionRetries: 5,
    // gram-js prints extensive INFO logs by default — quiet it down so
    // the bridge dev server console stays readable. Errors still flow
    // through to console.warn via our wrappers.
    baseLogger: undefined,
  });
  // gram-js's `.connect()` throws if the session is invalid; we let
  // that bubble up so callers can degrade gracefully.
  await client.connect();
  // Sanity check: confirm we're still authorized. A revoked session
  // returns false here without throwing.
  const authorized = await client.checkAuthorization();
  if (!authorized) {
    try { await client.disconnect(); } catch { /* ignore */ }
    throw new Error(
      "Telegram user session is no longer authorized — re-run `bun scripts/telegram-login.ts`",
    );
  }
  // Re-attach any registered inbound handlers to the new client so a
  // settings swap doesn't drop them. Replace the old wrapper handle
  // (which pointed at the previous, now-disconnected client) with
  // the freshly-registered one so a future unsubscribe removes the
  // CURRENT listener, not the stale closure on the dead client.
  for (const [h] of state.inboundHandlers) {
    const dispatcher = makeMessageDispatcher(h);
    client.addEventHandler(dispatcher, new NewMessage({}));
    state.inboundHandlers.set(h, dispatcher);
  }
  return client;
}

/**
 * Probe the cached client's MTProto connection state. gram-js 2.x
 * exposes `connected` (boolean | undefined) and `disconnected`
 * (boolean) as plain getters — there is no Promise we can `.then()`
 * on, and no public event that fires when the underlying socket
 * drops. So we eagerly probe on every getTelegramUserClient() call:
 * if the cached client thinks it's disconnected, drop our reference
 * so the next call rebuilds. This catches:
 *   - server-side session revocation (Telegram closes the socket)
 *   - long network outages where gram-js gives up reconnecting
 *   - explicit `disconnect()` from another code path
 *
 * Returns true when the client is healthy, false when stale.
 */
function isClientLive(client: TelegramClient): boolean {
  const w = client as TelegramClient & {
    connected?: boolean;
    disconnected?: boolean;
  };
  // `disconnected === true` is the explicit "we're not on a socket" signal.
  // `connected === false` is the same thing seen from the other side.
  // Either one means: don't trust this handle.
  if (w.disconnected === true) return false;
  if (w.connected === false) return false;
  return true;
}

/**
 * Public entry. Returns a connected client, or null when not
 * configured. Throws only on a configured-but-broken auth — caller is
 * expected to catch + log + fall through to bot if appropriate.
 */
export async function getTelegramUserClient(): Promise<TelegramClient | null> {
  const fp = credsFingerprint();
  // Cred change → drop the cached client; the new connect happens below.
  if (state.client && state.credsHash !== fp) {
    try { await state.client.disconnect(); } catch { /* ignore */ }
    state.client = null;
    state.connecting = null;
  }
  // Liveness check — the cached client may be a zombie (socket dropped
  // by Telegram, session revoked, network outage). Without this probe
  // every subsequent sendMessage would throw against the dead handle
  // and notifications would silently stop until process restart.
  if (state.client && !isClientLive(state.client)) {
    console.warn(
      "[telegram-user] cached client is disconnected — rebuilding on next request",
    );
    try { await state.client.disconnect(); } catch { /* ignore */ }
    state.client = null;
    state.connecting = null;
  }
  if (state.client) return state.client;
  if (state.connecting) return state.connecting;
  state.credsHash = fp;
  state.connecting = (async () => {
    try {
      const c = await buildAndConnect();
      state.client = c;
      return c;
    } catch (err) {
      console.warn(
        "[telegram-user] connect failed:",
        (err as Error).message,
      );
      state.client = null;
      throw err;
    } finally {
      state.connecting = null;
    }
  })();
  return state.connecting;
}

export async function disconnectTelegramUserClient(): Promise<void> {
  const c = state.client;
  state.client = null;
  state.connecting = null;
  if (c) {
    try { await c.disconnect(); } catch { /* ignore */ }
  }
}

/**
 * Resolve the `targetChatId` to whatever gram-js's sendMessage accepts.
 * Empty string → "me" (the operator's own Saved Messages chat).
 * Numeric strings → `big-integer` BigInteger (gram-js's `EntityLike`
 *   uses the `big-integer` package, NOT the native `bigint` — they're
 *   not interchangeable in the type signatures).
 * Anything else → passed through (lets @username work).
 */
async function resolveTarget(target: string): Promise<unknown> {
  const t = target.trim();
  if (!t) return "me";
  if (/^-?\d+$/.test(t)) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const bigInt = require("big-integer") as typeof import("big-integer");
      return bigInt(t);
    } catch { /* fall through to string */ }
  }
  return t;
}

/**
 * Send a message via the user-client. Returns true on success, false
 * if not configured, throws on a real send failure (bad target,
 * network, etc.) so callers can surface the error.
 *
 * `target` defaults to the configured `targetChatId` (or "me" if
 * empty). Pass an explicit target to override per-call.
 */
export async function sendUserMessage(
  text: string,
  opts: { target?: string; parseMode?: "html" | "md" | undefined } = {},
): Promise<boolean> {
  if (!isUserClientConfigured()) return false;
  const settings = getManifestTelegramSettings().user;
  const client = await getTelegramUserClient();
  if (!client) return false;
  const target = await resolveTarget(opts.target ?? settings.targetChatId);
  // gram-js's `EntityLike` uses `big-integer.BigInteger`, but the type
  // export isn't compatible with `unknown` directly — we cast at the
  // call site so the rest of this module stays oblivious to gram-js's
  // internal type churn.
  await client.sendMessage(target as Parameters<TelegramClient["sendMessage"]>[0], {
    message: text,
    parseMode: opts.parseMode,
  });
  return true;
}

/**
 * Get info about the currently logged-in user — used by the test
 * endpoint to confirm "yes, this session is alive".
 */
export async function getUserClientSelf(): Promise<{
  id: string;
  username: string;
  firstName: string;
  phone: string;
} | null> {
  if (!isUserClientConfigured()) return null;
  const client = await getTelegramUserClient();
  if (!client) return null;
  const me = await client.getMe();
  // The `getMe` return shape is `Api.User`; we unwrap the bits we want.
  // Cast through unknown because the gram-js types pull in a giant
  // RPC-method discriminated union we don't want to leak here.
  const u = me as unknown as {
    id?: { toString(): string };
    username?: string;
    firstName?: string;
    phone?: string;
  };
  return {
    id: u.id?.toString() ?? "",
    username: u.username ?? "",
    firstName: u.firstName ?? "",
    phone: u.phone ?? "",
  };
}

/**
 * Wrap a user-supplied handler with the boilerplate to extract a
 * stable `InboundMessage` shape from gram-js's event payload.
 */
function makeMessageDispatcher(
  handler: InboundHandler,
): (event: unknown) => void {
  return (event) => {
    try {
      const ev = event as {
        message?: {
          message?: string;
          id?: number;
          peerId?: { userId?: { toString(): string }; chatId?: { toString(): string }; channelId?: { toString(): string } };
          fromId?: { userId?: { toString(): string } };
          isPrivate?: boolean;
        };
      };
      const msg = ev.message;
      if (!msg || typeof msg.message !== "string") return;
      const peer = msg.peerId ?? {};
      const chatIdRaw =
        peer.userId?.toString() ??
        peer.chatId?.toString() ??
        peer.channelId?.toString() ??
        "";
      const senderId = msg.fromId?.userId?.toString() ?? chatIdRaw;
      const result = handler({
        chatId: chatIdRaw,
        messageId: typeof msg.id === "number" ? msg.id : 0,
        senderId,
        text: msg.message,
        isPrivate: msg.isPrivate === true,
      });
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch((err: Error) => {
          console.warn("[telegram-user] handler error:", err.message);
        });
      }
    } catch (err) {
      console.warn("[telegram-user] dispatcher crashed:", (err as Error).message);
    }
  };
}

/**
 * Subscribe to inbound messages on the user-client. Returns an
 * unsubscribe function. Idempotent — safe to call multiple times with
 * different handlers; each gets its own `addEventHandler` slot.
 *
 * Handlers persist across reconnects (the registry is module-level).
 */
export async function subscribeUserMessages(
  handler: InboundHandler,
): Promise<() => void> {
  // Reserve a slot in the registry up front so a reconnect that races
  // the attach below still re-attaches us. The dispatcher slot is
  // replaced once we actually register with gram-js.
  if (!state.inboundHandlers.has(handler)) {
    state.inboundHandlers.set(handler, () => { /* placeholder */ });
  }
  if (isUserClientConfigured()) {
    try {
      const client = await getTelegramUserClient();
      if (client) {
        const { NewMessage } = await loadGramJs();
        const dispatcher = makeMessageDispatcher(handler);
        client.addEventHandler(dispatcher, new NewMessage({}));
        state.inboundHandlers.set(handler, dispatcher);
      }
    } catch (err) {
      console.warn(
        "[telegram-user] subscribe failed (will retry on next connect):",
        (err as Error).message,
      );
    }
  }
  return () => {
    const dispatcher = state.inboundHandlers.get(handler);
    state.inboundHandlers.delete(handler);
    // Pull the dispatcher OUT of gram-js's internal listener list.
    // Without this, repeated subscribe/unsubscribe cycles (every
    // settings reload triggers one) accumulate dead closures inside
    // gram-js's dispatcher table, each one fired on every inbound
    // message — eventually a measurable per-message overhead.
    if (dispatcher && state.client) {
      try {
        // gram-js's `removeEventHandler` API matches by the function
        // reference we passed to `addEventHandler`. We tracked that
        // ref in the map specifically so this removal works.
        (state.client as unknown as { removeEventHandler?: (fn: unknown) => void })
          .removeEventHandler?.(dispatcher);
      } catch (err) {
        console.warn("[telegram-user] removeEventHandler failed:", (err as Error).message);
      }
    }
  };
}
