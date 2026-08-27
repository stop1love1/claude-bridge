/**
 * Shared retry/backoff policy for outbound Telegram Bot API
 * `sendMessage` calls.
 *
 * Extracted from `telegramNotifier.sendViaBot` (the pre-existing
 * correct implementation) so `telegramCommands.sendReply` can reuse it
 * instead of reimplementing it. Before this extraction `sendReply` was
 * a single attempt whose failure was only `console.warn`'d server-side
 * — a transient 429/5xx, or a parse_mode mismatch after a truncation
 * cut mid-tag, silently dropped the operator's command reply with no
 * retry and no fallback (audit H9). This module is the one
 * implementation both `sendViaBot` and `sendReply` now share: 429 →
 * honor `retry_after`, 5xx / network error → exponential backoff, and
 * a parse-mode 400 → resend once as plain text.
 *
 * Deliberately excludes `sendViaBot`'s per-chat serialization queue
 * (`enqueueBotSend` in `telegramNotifier.ts`) — that's a queuing
 * concern layered ABOVE this retry policy, not part of it, and
 * `sendReply` doesn't have an equivalent queue yet. That asymmetry is
 * a known, separately-tracked gap — not part of this fix.
 */

const MAX_ATTEMPTS = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Telegram returns 429 like:
 *   { ok:false, error_code:429, parameters:{ retry_after: 5 } }
 * Some proxies also surface a `Retry-After` header. Prefer the body
 * field (more accurate), fall back to the header, default to 1s. Cap
 * at 30s so a misconfigured server can't park the caller forever.
 */
export function parseRetryAfter(body: string, header: string | null): number {
  try {
    const parsed = JSON.parse(body) as {
      parameters?: { retry_after?: unknown };
    };
    const ra = parsed.parameters?.retry_after;
    if (typeof ra === "number" && ra > 0) {
      return Math.min(30_000, Math.ceil(ra * 1000));
    }
  } catch { /* not JSON */ }
  if (header) {
    const n = Number(header);
    if (Number.isFinite(n) && n > 0) {
      return Math.min(30_000, Math.ceil(n * 1000));
    }
  }
  return 1000;
}

/**
 * POST to a Telegram `sendMessage`-shaped URL with up to `MAX_ATTEMPTS`
 * (4) attempts:
 *   - 429 honors `parameters.retry_after`.
 *   - 5xx / network error backs off exponentially (0.5s, 1s, 2s) so a
 *     flaky network or transient Telegram outage doesn't drop the send.
 *   - 400 "can't parse entities" / "can't find end of" resends ONCE
 *     without `parse_mode` — better a raw/unformatted message than a
 *     dropped one.
 *
 * `buildBody` is invoked fresh for each attempt with whether the
 * plain-text fallback is currently active, and returns the JSON body
 * for THAT attempt — callers own their own field set (chat_id, text,
 * parse_mode, reply_to_message_id, disable_web_page_preview, …) since
 * the two current call sites use different parse modes (MarkdownV2 vs
 * HTML) and only one of them sets `reply_to_message_id`.
 *
 * Never throws — a final failure is `console.warn`'d with `logPrefix`
 * so it stays attributable in server logs, matching every other
 * outbound Telegram call in this codebase.
 */
export async function sendTelegramApiMessage(
  url: string,
  buildBody: (plainFallbackUsed: boolean) => Record<string, unknown>,
  logPrefix: string,
): Promise<void> {
  let plainFallbackUsed = false;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildBody(plainFallbackUsed)),
        // 10s upper bound: Telegram is fast in the happy path; we
        // don't want a slow connection to wedge the caller.
        signal: AbortSignal.timeout(10_000),
      });
      if (r.ok) return;

      const bodyText = await r.text().catch(() => "");
      // 429 — Telegram tells us how long to wait via the parsed body.
      if (r.status === 429) {
        const retryAfter = parseRetryAfter(bodyText, r.headers.get("retry-after"));
        if (attempt < MAX_ATTEMPTS - 1) {
          await sleep(retryAfter);
          continue;
        }
      }
      // 5xx / 502 / 504 — transient. Back off and retry.
      if (r.status >= 500 && attempt < MAX_ATTEMPTS - 1) {
        await sleep(500 * Math.pow(2, attempt));
        continue;
      }
      // 400 with "can't parse entities" → formatting escaped/converted
      // wrong for some payload; resend as plain text instead of
      // dropping the message entirely.
      if (
        r.status === 400 &&
        /can't parse entities|can't find end of/i.test(bodyText) &&
        !plainFallbackUsed &&
        attempt < MAX_ATTEMPTS - 1
      ) {
        plainFallbackUsed = true;
        continue;
      }
      console.warn(`${logPrefix} send failed: ${r.status} ${bodyText.slice(0, 200)}`);
      return;
    } catch (err) {
      // AbortError / network error — retry with backoff.
      if (attempt < MAX_ATTEMPTS - 1) {
        await sleep(500 * Math.pow(2, attempt));
        continue;
      }
      console.warn(`${logPrefix} send error: ${(err as Error).message}`);
      return;
    }
  }
}
