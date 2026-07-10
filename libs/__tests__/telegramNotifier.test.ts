import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `ensureTelegramNotifier` used to early-return before installing ANY
 * of its event subscriptions (`subscribeMetaAll` / `subscribeAllPermissions`
 * / `subscribeLoginApprovals`) when neither Telegram channel was
 * configured. Those same subscriptions are what drive the Task 9
 * web-push fan-out (`notifyPush` calls live inside the subscribed
 * handlers) — so a push-only operator (no Telegram bot/user-client
 * credentials, but a browser subscribed via `/api/push/subscribe`)
 * never got notified of anything. Fix: install the subscriptions
 * unconditionally and gate only the Telegram *sends* on credentials.
 *
 * This test proves the fix by configuring zero Telegram credentials,
 * calling `ensureTelegramNotifier()`, then firing a real event through
 * `loginApprovals.createPendingLogin` (same trigger used by
 * `telegramLoginCommands.test.ts`'s notifier-hook tests) and asserting
 * `sendPushToAll` — mocked here — still gets called.
 */

const sendPushToAll = vi.fn().mockResolvedValue(undefined);
vi.mock("../webPush", () => ({
  sendPushToAll: (...args: unknown[]) => sendPushToAll(...args),
}));

// Force both Telegram channels to read as "unconfigured" regardless of
// whatever the real bridge.json / env on this machine happens to have,
// so the test is deterministic wherever it runs.
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

    // Double-install would double-subscribe and fire the push twice.
    expect(sendPushToAll).toHaveBeenCalledTimes(1);
  });
});
