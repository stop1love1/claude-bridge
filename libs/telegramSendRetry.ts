
const MAX_ATTEMPTS = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function parseRetryAfter(body: string, header: string | null): number {
  try {
    const parsed = JSON.parse(body) as {
      parameters?: { retry_after?: unknown };
    };
    const ra = parsed.parameters?.retry_after;
    if (typeof ra === "number" && ra > 0) {
      return Math.min(30_000, Math.ceil(ra * 1000));
    }
  } catch { }
  if (header) {
    const n = Number(header);
    if (Number.isFinite(n) && n > 0) {
      return Math.min(30_000, Math.ceil(n * 1000));
    }
  }
  return 1000;
}

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
        signal: AbortSignal.timeout(10_000),
      });
      if (r.ok) return;

      const bodyText = await r.text().catch(() => "");
      if (r.status === 429) {
        const retryAfter = parseRetryAfter(bodyText, r.headers.get("retry-after"));
        if (attempt < MAX_ATTEMPTS - 1) {
          await sleep(retryAfter);
          continue;
        }
      }
      if (r.status >= 500 && attempt < MAX_ATTEMPTS - 1) {
        await sleep(500 * Math.pow(2, attempt));
        continue;
      }
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
      if (attempt < MAX_ATTEMPTS - 1) {
        await sleep(500 * Math.pow(2, attempt));
        continue;
      }
      console.warn(`${logPrefix} send error: ${(err as Error).message}`);
      return;
    }
  }
}
