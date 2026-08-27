import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";


const sendPushToAll = vi.fn().mockResolvedValue(undefined);
vi.mock("../webPush", () => ({
  sendPushToAll: (...args: unknown[]) => sendPushToAll(...args),
}));

vi.mock("../apps", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../apps")>();
  return {
    ...actual,
    getManifestTelegramSettings: () => ({
      botToken: "",
      chatId: "",
      user: { ...actual.DEFAULT_TELEGRAM_USER_SETTINGS },
      forwardChat: false,
      forwardChatMinChars: 0,
      notificationLevel: "normal" as const,
      forwardChatFilter: "all" as const,
      forwardChatImportantPatterns: [],
    }),
  };
});

beforeEach(() => {
  vi.resetModules();
  sendPushToAll.mockClear();
  delete (globalThis as { __bridgeTelegramNotifier?: unknown }).__bridgeTelegramNotifier;
  delete (globalThis as { __bridgeTelegramChatForwarder?: unknown }).__bridgeTelegramChatForwarder;
  delete (globalThis as { __bridgeLoginApprovals?: unknown }).__bridgeLoginApprovals;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
});

afterEach(() => {
  vi.resetModules();
});

describe("ensureTelegramNotifier — push fan-out without Telegram credentials", () => {
  it("still installs the login-approval subscription and fans out a push when a pending login lands", async () => {
    const { ensureTelegramNotifier } = await import("../telegramNotifier");
    ensureTelegramNotifier();

    const { createPendingLogin } = await import("../loginApprovals");
    createPendingLogin({
      email: "op@example.com",
      trust: true,
      deviceLabel: "Chrome on Windows",
      remoteIp: "203.0.113.5",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128",
    });

    expect(sendPushToAll).toHaveBeenCalledTimes(1);
    expect(sendPushToAll).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringContaining("device login pending") }),
    );
  });

  it("is a no-op the second time it's called (installs subscriptions exactly once)", async () => {
    const { ensureTelegramNotifier } = await import("../telegramNotifier");
    ensureTelegramNotifier();
    ensureTelegramNotifier();

    const { createPendingLogin } = await import("../loginApprovals");
    createPendingLogin({
      email: "op@example.com",
      trust: true,
      deviceLabel: "Chrome",
      remoteIp: "203.0.113.5",
      userAgent: "Mozilla/5.0",
    });

    expect(sendPushToAll).toHaveBeenCalledTimes(1);
  });
});
