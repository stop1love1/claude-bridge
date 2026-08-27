import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../apps", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../apps")>();
  return {
    ...actual,
    getManifestTelegramSettings: () => ({
      botToken: "test-token",
      chatId: "555",
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
  delete (globalThis as { __bridgeTelegramBotQueues?: unknown }).__bridgeTelegramBotQueues;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("sendTelegramRaw — per-chat serialization survives the retry-policy extraction", () => {
  it("does not let two concurrent sends to the same chat overlap their fetch calls", async () => {
    let inFlight = 0;
    let sawOverlap = false;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      inFlight++;
      if (inFlight > 1) sawOverlap = true;
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const { sendTelegramRaw } = await import("../telegramNotifier");

    await Promise.all([sendTelegramRaw("first"), sendTelegramRaw("second")]);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(sawOverlap).toBe(false);
  });
});
