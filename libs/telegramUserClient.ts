
import type { TelegramClient } from "telegram";
import { getManifestTelegramSettings } from "./apps";

interface UserClientState {
  client: TelegramClient | null;
  connecting: Promise<TelegramClient | null> | null;
  credsHash: string;
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
  chatId: string;
  messageId: number;
  senderId: string;
  text: string;
  isPrivate: boolean;
}

export type InboundHandler = (msg: InboundMessage) => void | Promise<void>;

function credsFingerprint(): string {
  const s = getManifestTelegramSettings().user;
  return `${s.apiId}:${s.apiHash}:${s.session.length}:${s.session.slice(-12)}`;
}

export function isUserClientConfigured(): boolean {
  const s = getManifestTelegramSettings().user;
  return s.apiId > 0 && s.apiHash.length > 0 && s.session.length > 0;
}

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

async function buildAndConnect(): Promise<TelegramClient | null> {
  const settings = getManifestTelegramSettings().user;
  if (!isUserClientConfigured()) return null;

  const { TelegramClient, StringSession, NewMessage } = await loadGramJs();
  const session = new StringSession(settings.session);
  const client = new TelegramClient(session, settings.apiId, settings.apiHash, {
    connectionRetries: 5,
    baseLogger: undefined,
  });
  await client.connect();
  const authorized = await client.checkAuthorization();
  if (!authorized) {
    try { await client.disconnect(); } catch { }
    throw new Error(
      "Telegram user session is no longer authorized — re-run `bun scripts/telegram-login.ts`",
    );
  }
  for (const [h] of state.inboundHandlers) {
    const dispatcher = makeMessageDispatcher(h);
    client.addEventHandler(dispatcher, new NewMessage({}));
    state.inboundHandlers.set(h, dispatcher);
  }
  return client;
}

function isClientLive(client: TelegramClient): boolean {
  const w = client as TelegramClient & {
    connected?: boolean;
    disconnected?: boolean;
  };
  if (w.disconnected === true) return false;
  if (w.connected === false) return false;
  return true;
}

export async function getTelegramUserClient(): Promise<TelegramClient | null> {
  const fp = credsFingerprint();
  if (state.client && state.credsHash !== fp) {
    try { await state.client.disconnect(); } catch { }
    state.client = null;
    state.connecting = null;
  }
  if (state.client && !isClientLive(state.client)) {
    console.warn(
      "[telegram-user] cached client is disconnected — rebuilding on next request",
    );
    try { await state.client.disconnect(); } catch { }
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
    try { await c.disconnect(); } catch { }
  }
}

async function resolveTarget(target: string): Promise<unknown> {
  const t = target.trim();
  if (!t) return "me";
  if (/^-?\d+$/.test(t)) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const bigInt = require("big-integer") as typeof import("big-integer");
      return bigInt(t);
    } catch { }
  }
  return t;
}

export async function sendUserMessage(
  text: string,
  opts: { target?: string; parseMode?: "html" | "md" | undefined } = {},
): Promise<boolean> {
  if (!isUserClientConfigured()) return false;
  const settings = getManifestTelegramSettings().user;
  const client = await getTelegramUserClient();
  if (!client) return false;
  const target = await resolveTarget(opts.target ?? settings.targetChatId);
  await client.sendMessage(target as Parameters<TelegramClient["sendMessage"]>[0], {
    message: text,
    parseMode: opts.parseMode,
  });
  return true;
}

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

export async function subscribeUserMessages(
  handler: InboundHandler,
): Promise<() => void> {
  if (!state.inboundHandlers.has(handler)) {
    state.inboundHandlers.set(handler, () => { });
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
    if (dispatcher && state.client) {
      try {
        (state.client as unknown as { removeEventHandler?: (fn: unknown) => void })
          .removeEventHandler?.(dispatcher);
      } catch (err) {
        console.warn("[telegram-user] removeEventHandler failed:", (err as Error).message);
      }
    }
  };
}
