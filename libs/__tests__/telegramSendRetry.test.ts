import { describe, it, expect, vi, afterEach } from "vitest";
import { sendTelegramApiMessage, parseRetryAfter } from "../telegramSendRetry";

/**
 * Shared retry/backoff policy extracted from `telegramNotifier.sendViaBot`
 * (the pre-existing correct implementation) so `telegramCommands.sendReply`
 * can reuse it instead of reimplementing it — before this extraction
 * `sendReply` was a single attempt whose failure was only
 * `console.warn`'d server-side, so a transient 429/5xx or a parse_mode
 * mismatch silently dropped the operator's command reply (audit H9).
 *
 * These tests exercise the policy directly, independent of either
 * caller, so both `sendViaBot` and `sendReply` inherit coverage from
 * one place.
 */

function jsonResponse(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

describe("parseRetryAfter", () => {
  it("reads parameters.retry_after from the response body (seconds -> ms)", () => {
    const ms = parseRetryAfter(JSON.stringify({ parameters: { retry_after: 2 } }), null);
    expect(ms).toBe(2000);
  });

  it("falls back to the Retry-After header when the body has no usable field", () => {
    const ms = parseRetryAfter("not json", "3");
    expect(ms).toBe(3000);
  });

  it("defaults to 1000ms when neither source has a usable value", () => {
    expect(parseRetryAfter("", null)).toBe(1000);
  });

  it("caps at 30s even if Telegram asks for longer", () => {
    const ms = parseRetryAfter(JSON.stringify({ parameters: { retry_after: 999 } }), null);
    expect(ms).toBe(30_000);
  });
});

describe("sendTelegramApiMessage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends successfully on the first attempt with no retries", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(200, { ok: true }));

    await sendTelegramApiMessage(
      "https://api.telegram.org/botX/sendMessage",
      () => ({ chat_id: "1", text: "hi" }),
      "[test]",
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("retries once without parse_mode after a 400 'can't parse entities' response, then succeeds", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse(400, {
          ok: false,
          description: "Bad Request: can't parse entities: Unsupported tag",
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const bodies: Record<string, unknown>[] = [];
    await sendTelegramApiMessage(
      "https://api.telegram.org/botX/sendMessage",
      (plainFallbackUsed) => {
        const body: Record<string, unknown> = { chat_id: "1", text: "hi" };
        if (!plainFallbackUsed) body.parse_mode = "HTML";
        bodies.push(body);
        return body;
      },
      "[test]",
    );

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(bodies[0]!.parse_mode).toBe("HTML");
    expect(bodies[1]!.parse_mode).toBeUndefined();
  });

  it("gives up after the fallback also gets a parse error, and logs a warning", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse(400, { ok: false, description: "Bad Request: can't parse entities" }),
      );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await sendTelegramApiMessage(
      "https://api.telegram.org/botX/sendMessage",
      () => ({ chat_id: "1", text: "hi" }),
      "[test]",
    );

    // Attempt 0 uses the fallback; attempt 1 is already plain-text and
    // still gets a 400, so the loop gives up instead of retrying forever.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("honors retry_after on 429 and eventually succeeds", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(429, { parameters: { retry_after: 0.01 } }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    await sendTelegramApiMessage(
      "https://api.telegram.org/botX/sendMessage",
      () => ({ chat_id: "1", text: "hi" }),
      "[test]",
    );

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("backs off and retries once on a 5xx, then succeeds", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(502, "bad gateway"))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    await sendTelegramApiMessage(
      "https://api.telegram.org/botX/sendMessage",
      () => ({ chat_id: "1", text: "hi" }),
      "[test]",
    );

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  }, 10_000);

  it("retries once on a network error (fetch throws), then succeeds", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    await sendTelegramApiMessage(
      "https://api.telegram.org/botX/sendMessage",
      () => ({ chat_id: "1", text: "hi" }),
      "[test]",
    );

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  }, 10_000);
});
