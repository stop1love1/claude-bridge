import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  dispatchCommand,
  buildPollSignal,
  fetchUpdates,
  buildReplyBody,
  capListLines,
  LIST_CAP,
  sendReply,
} from "../telegramCommands";

/**
 * These tests cover the pure dispatcher + parser + validation layer of
 * `lib/telegramCommands`. Side-effecting handlers (`/done`, `/new`,
 * `/clear`, …) are exercised by the underlying lib tests
 * (`tasks.test.ts`, `meta.test.ts`, etc.); duplicating them here would
 * couple this suite to disk state those suites already cover.
 *
 * What we DO assert:
 *   - command name parsing (leading slash, `@botname` suffix, args)
 *   - unknown command path
 *   - usage / validation messages for `<id>` and `<reqId>` arguments
 *   - help text contains every registered command
 */
describe("dispatchCommand — parsing", () => {
  it("returns an 'unknown command' message for unknown slugs", async () => {
    const out = await dispatchCommand("/wat");
    expect(out).toMatch(/Unknown command/);
    expect(out).toMatch(/`\/wat`/);
  });

  it("strips the @botname suffix Telegram appends in groups", async () => {
    const out = await dispatchCommand("/help@my_bridge_bot");
    // Should land on the help handler, NOT the unknown branch.
    expect(out).not.toMatch(/Unknown command/);
    expect(out).toMatch(/Bridge commands/i);
  });

  it("treats commands case-insensitively", async () => {
    const a = await dispatchCommand("/HELP");
    const b = await dispatchCommand("/help");
    expect(a).toBe(b);
  });

  it("returns usage text when a side-effecting command lacks arguments", async () => {
    const out = await dispatchCommand("/done");
    expect(out).toMatch(/Usage:/);
  });

  it("rejects malformed task ids", async () => {
    const out = await dispatchCommand("/done not-a-task-id");
    expect(out).toMatch(/Invalid task id/);
  });

  it("rejects malformed task ids for /reopen too", async () => {
    const out = await dispatchCommand("/reopen 123");
    expect(out).toMatch(/Invalid task id/);
  });

  it("preserves rawTail for /new (multi-word body, no split)", async () => {
    // Empty body → usage hint, not a "Created" reply (we don't want
    // /new to create anything when called with nothing).
    const out = await dispatchCommand("/new");
    expect(out).toMatch(/Usage:/);
    expect(out).not.toMatch(/Created/);
  });
});

describe("dispatchCommand — /help content", () => {
  it("lists every registered command", async () => {
    const help = await dispatchCommand("/help");
    // Spot-check across tier-0 / tier-1 / tier-2 surfaces. If any of
    // these disappears the help drift check fires immediately.
    for (const cmd of [
      "/tasks",
      "/done",
      "/reopen",
      "/retry",
      "/kill",
      "/delete",
      "/new",
      "/continue",
      "/clear",
      "/summary",
      "/report",
      "/usage",
      "/refresh",
      "/allow",
      "/deny",
      "/scan",
      "/runs",
      "/pending",
    ]) {
      expect(help).toContain(cmd);
    }
  });

  it("/start is an alias for /help with a welcome line", async () => {
    const out = await dispatchCommand("/start");
    expect(out).toMatch(/Welcome to Claude Bridge/);
    expect(out).toContain("/help");
  });
});

describe("dispatchCommand — permission answer parsing", () => {
  it("requires a request-id argument", async () => {
    const out = await dispatchCommand("/allow");
    expect(out).toMatch(/Usage:/);
  });

  it("rejects too-short prefixes (< 6 chars) to avoid ambiguity", async () => {
    const out = await dispatchCommand("/allow abc");
    expect(out).toMatch(/too short/i);
  });

  it("returns 'no pending request' when nothing matches", async () => {
    // 6+ char prefix that is extraordinarily unlikely to collide with
    // any pending request that another test may have left in the
    // module-level permissionStore.
    const out = await dispatchCommand(
      "/allow zzzzzzzz-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    );
    expect(out).toMatch(/No pending request/);
  });

  it("/deny mirrors /allow's validation", async () => {
    const out = await dispatchCommand("/deny");
    expect(out).toMatch(/Usage:/);
  });
});

describe("dispatchCommand — report parsing", () => {
  it("requires both id and role", async () => {
    const out = await dispatchCommand("/report t_20260424_001");
    expect(out).toMatch(/Usage:/);
  });

  it("rejects malformed task ids", async () => {
    const out = await dispatchCommand("/report not-an-id coder");
    expect(out).toMatch(/Invalid task id/);
  });
});

describe("dispatchCommand — read-only commands handle empty state", () => {
  it("/pending returns the no-pending message when the store is empty", async () => {
    // Other tests in the suite may have left pending entries; we just
    // assert the dispatcher doesn't crash. If the store happens to be
    // empty, the green-checkmark message is what we get.
    const out = await dispatchCommand("/pending");
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });

  it("/active returns a valid string regardless of run state", async () => {
    const out = await dispatchCommand("/active");
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });

  it("/apps returns a valid string regardless of bridge.json contents", async () => {
    const out = await dispatchCommand("/apps");
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });
});

/**
 * H8 — `fetchUpdates` used to pass `poller.abort?.signal` straight to
 * `fetch`, which only fires on an explicit shutdown. A stalled
 * connection (no clean FIN — routine on a laptop that sleeps or drops
 * Wi-Fi) left the `await fetch` pending forever, so `runLoop`'s catch
 * and its restart backoff never ran. `buildPollSignal` composes a
 * request-level deadline with the shutdown signal so each getUpdates
 * call is bounded no matter what the connection does.
 */
describe("buildPollSignal — bounds the long-poll per request (audit H8)", () => {
  it("is not already aborted right after construction", () => {
    const sig = buildPollSignal(undefined);
    expect(sig.aborted).toBe(false);
  });

  it("aborts immediately when the shutdown signal is already aborted (real shutdown still works)", () => {
    const shutdown = new AbortController();
    shutdown.abort();
    const sig = buildPollSignal(shutdown.signal);
    expect(sig.aborted).toBe(true);
  });

  it("aborts promptly the moment shutdown fires, without waiting for the deadline", () => {
    const shutdown = new AbortController();
    const sig = buildPollSignal(shutdown.signal, 60_000);
    expect(sig.aborted).toBe(false);
    shutdown.abort();
    // AbortSignal.any propagates synchronously — no need to await.
    expect(sig.aborted).toBe(true);
  });

  it("aborts on its own after the deadline elapses, independent of any shutdown signal", async () => {
    // A vitest fake-timer probe confirmed AbortSignal.timeout's internal
    // timer is NOT intercepted by vi.useFakeTimers() in this Bun +
    // vitest setup (it advanced 5001ms of fake time and the signal
    // never fired) — so this test uses a short REAL deadline via the
    // overridable `deadlineMs` param instead of the ~35s production one.
    const sig = buildPollSignal(undefined, 20);
    expect(sig.aborted).toBe(false);
    await new Promise((r) => setTimeout(r, 150));
    expect(sig.aborted).toBe(true);
  });

  it("does not abort early just because a (non-firing) shutdown signal exists", async () => {
    const shutdown = new AbortController();
    const sig = buildPollSignal(shutdown.signal, 150);
    await new Promise((r) => setTimeout(r, 20));
    expect(sig.aborted).toBe(false);
  });
});

describe("fetchUpdates — wires a composed, non-shutdown-only signal into fetch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes an AbortSignal that is not already aborted to fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 }),
    );

    await fetchUpdates("fake-token", 0);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal!.aborted).toBe(false);
  });
});

/**
 * H9 — list renderers used to emit one unbounded line per row, and
 * `sendReply` truncated the ALREADY-html-converted string, so a cut
 * had a high chance of landing inside a tag and Telegram rejected the
 * whole `sendMessage` with 400 "can't parse entities". The fix has two
 * parts: cap the renderers so truncation is rarely reached at all
 * (`capListLines`), and when truncation IS needed, cut the pre-HTML
 * markdown-lite text so `mdLiteToHtml` always emits balanced tags by
 * construction (`buildReplyBody`).
 */
describe("capListLines — bound list renderers with a +K more suffix", () => {
  it("returns the input unchanged when at or under the cap", () => {
    const rows = Array.from({ length: 5 }, (_, i) => `row ${i}`);
    expect(capListLines(rows, 5)).toEqual(rows);
  });

  it("caps and appends a '+K more' suffix line when over the cap, rather than a hard cut", () => {
    const rows = Array.from({ length: 120 }, (_, i) => `row ${i}`);
    const out = capListLines(rows, 20);
    expect(out).toHaveLength(21);
    expect(out.slice(0, 20)).toEqual(rows.slice(0, 20));
    expect(out[20]).toMatch(/\+100 more/);
  });
});

describe("buildReplyBody — truncate before HTML conversion (audit H9)", () => {
  it("truncates before HTML conversion so tags stay balanced", () => {
    const long = Array.from(
      { length: 200 },
      (_, i) => `- \`t_2026_${i}\` *title ${i}*`,
    ).join("\n");
    const out = buildReplyBody(long);
    // Proves truncation actually happened (the last row is cut off) —
    // otherwise the balance assertion below would trivially hold on
    // the untruncated content instead of exercising the fix. (Can't
    // compare `out.length` to `long.length` directly: HTML tag
    // overhead legitimately makes the converted-and-truncated output
    // longer than the raw pre-conversion string in raw character count.)
    expect(out).not.toContain("title 199");
    const opens = (out.match(/<(b|code)>/g) ?? []).length;
    const closes = (out.match(/<\/(b|code)>/g) ?? []).length;
    expect(opens).toBeGreaterThan(0);
    expect(opens).toBe(closes);
  });

  it("degrades a code span truncated mid-token to plain text instead of an orphan tag", () => {
    // Engineered so REPLY_MAX (3500) lands inside a single, very long,
    // unterminated code span — the worst case for "cut lands inside a
    // tag". If truncation ran on the ALREADY-converted HTML (the old
    // behavior), this would emit an unclosed `<code>`.
    const raw = "`" + "x".repeat(5000);
    const out = buildReplyBody(raw);
    expect(out).not.toContain("<code>");
    expect(out).not.toContain("</code>");
  });

  it("passes short text through unchanged aside from HTML conversion", () => {
    expect(buildReplyBody("`hi` *there*")).toBe("<code>hi</code> <b>there</b>");
  });
});

describe("sendReply — resilience via the shared retry helper (audit H9)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retries once without parse_mode after a 400 parse-error response instead of dropping the reply", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ok: false, description: "Bad Request: can't parse entities" }),
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await sendReply({ token: "fake-token", chatId: "123" }, "<b>hi</b>");

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(
      (fetchSpy.mock.calls[1]![1] as RequestInit).body as string,
    ) as Record<string, unknown>;
    expect(secondBody.parse_mode).toBeUndefined();
    expect(secondBody.text).toBe("<b>hi</b>");
  });
});

/**
 * Integration check: the pure `capListLines` helper is exercised above
 * in isolation, but this proves the real `renderTasks` (reached via
 * `/tasks`) is actually wired to it, using real tasks on disk. Follows
 * the chdir + resetModules + dynamic-import convention from
 * `telegramSummary.test.ts` — `SESSIONS_DIR` is captured at module load
 * from `process.cwd()`, so this needs its own fresh module graph
 * pointed at a temp "bridge root" rather than the statically-imported
 * `dispatchCommand` above (which is already bound to the real repo).
 */
describe("/tasks — end-to-end list cap via the real renderer", () => {
  let tempRoot: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tempRoot = mkdtempSync(join(tmpdir(), "bridge-tg-tasks-"));
    process.chdir(tempRoot);
    vi.resetModules();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.resetModules();
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it("shows every task with no '+more' suffix when at the cap", async () => {
    const { createTask } = await import("../tasksStore");
    const { dispatchCommand: freshDispatch } = await import("../telegramCommands");
    for (let i = 0; i < LIST_CAP; i++) {
      createTask({ title: `Task ${i}`, body: "", app: null });
    }
    const out = await freshDispatch("/tasks");
    expect(out).not.toMatch(/\+\d+ more/);
  });

  it("caps list output with a '+N more' suffix rather than a hard cut once over LIST_CAP", async () => {
    const { createTask } = await import("../tasksStore");
    const { dispatchCommand: freshDispatch } = await import("../telegramCommands");
    const total = LIST_CAP + 7;
    for (let i = 0; i < total; i++) {
      createTask({ title: `Task ${i}`, body: "", app: null });
    }
    const out = await freshDispatch("/tasks");
    expect(out).toMatch(new RegExp(`\\+${total - LIST_CAP} more`));
  });
});
