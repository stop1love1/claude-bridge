import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingLogin } from "../loginApprovals";

/**
 * Telegram device-login approval commands (`/logins`, `/approvelogin`,
 * `/denylogin`) plus the "new device login pending" notifier ping.
 *
 * `loginApprovals` stashes its in-memory map (and, as of Task 10, its
 * pub/sub emitter) on `globalThis` — same HMR-safe trick as
 * `permissionStore` / `spawnRegistry`. We delete that stash AND call
 * `vi.resetModules()` between tests (mirrors `telegramPlanCommands.test.ts`)
 * so every test gets a clean store and a freshly-bound `telegramCommands`
 * module pointing at it.
 *
 * Security note (mirrors the code comment in `telegramCommands.ts`):
 * answering `/approvelogin` / `/denylogin` from Telegram is equivalent
 * to a trusted device clicking Approve/Deny in the web UI's modal — the
 * chat-id allowlist is the ONLY auth boundary, same trust model as
 * `/allow` / `/deny` for permissions.
 */

beforeEach(() => {
  delete (globalThis as { __bridgeLoginApprovals?: unknown }).__bridgeLoginApprovals;
  vi.resetModules();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
  vi.doUnmock("../loginApprovals");
});

const sampleArgs = {
  email: "op@example.com",
  trust: true,
  deviceLabel: "Chrome on Windows",
  remoteIp: "203.0.113.5",
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128",
};

function makeEntry(id: string, overrides?: Partial<PendingLogin>): PendingLogin {
  return {
    id,
    email: sampleArgs.email,
    trust: true,
    deviceLabel: sampleArgs.deviceLabel,
    remoteIp: sampleArgs.remoteIp,
    userAgent: sampleArgs.userAgent,
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + 3 * 60 * 1000,
    status: "pending",
    ...overrides,
  };
}

describe("/logins", () => {
  it("reports no pending logins when the store is empty", async () => {
    const { dispatchCommand } = await import("../telegramCommands");
    const out = await dispatchCommand("/logins");
    expect(out).toMatch(/no pending device logins/i);
  });

  it("lists id-prefix, UA, IP, and age for each pending login", async () => {
    const t = Date.UTC(2026, 0, 1);
    vi.setSystemTime(t);
    const { createPendingLogin } = await import("../loginApprovals");
    const entry = createPendingLogin(sampleArgs);
    vi.advanceTimersByTime(5_000);
    const { dispatchCommand } = await import("../telegramCommands");
    const out = await dispatchCommand("/logins");
    expect(out).toContain(entry.id.slice(0, 8));
    expect(out).toContain("Chrome");
    expect(out).toContain(sampleArgs.remoteIp);
    expect(out).toMatch(/5s ago/);
  });

  it("only lists status=pending entries, not already-answered ones", async () => {
    const { createPendingLogin, answerPendingLogin } = await import("../loginApprovals");
    const a = createPendingLogin(sampleArgs);
    const b = createPendingLogin(sampleArgs);
    answerPendingLogin(b.id, "denied");
    const { dispatchCommand } = await import("../telegramCommands");
    const out = await dispatchCommand("/logins");
    expect(out).toContain(a.id.slice(0, 8));
    expect(out).not.toContain(b.id.slice(0, 8));
  });

  it("expired entries drop out of the listing", async () => {
    const { createPendingLogin, APPROVAL_TTL_MS } = await import("../loginApprovals");
    createPendingLogin(sampleArgs);
    vi.advanceTimersByTime(APPROVAL_TTL_MS + 1000);
    const { dispatchCommand } = await import("../telegramCommands");
    const out = await dispatchCommand("/logins");
    expect(out).toMatch(/no pending device logins/i);
  });
});

describe("/approvelogin", () => {
  it("returns usage when no id is given", async () => {
    const { dispatchCommand } = await import("../telegramCommands");
    const out = await dispatchCommand("/approvelogin");
    expect(out).toMatch(/Usage:/);
  });

  it("rejects prefixes shorter than 6 chars", async () => {
    const { dispatchCommand } = await import("../telegramCommands");
    const out = await dispatchCommand("/approvelogin abc");
    expect(out).toMatch(/too short/i);
  });

  it("reports no match for an unknown id", async () => {
    const { dispatchCommand } = await import("../telegramCommands");
    const out = await dispatchCommand("/approvelogin zzzzzzzzzzzzzzzz");
    expect(out).toMatch(/No pending login matching/i);
  });

  it("resolves a unique prefix, flips status to approved, and confirms", async () => {
    const { createPendingLogin, getPendingLogin } = await import("../loginApprovals");
    const entry = createPendingLogin(sampleArgs);
    const { dispatchCommand } = await import("../telegramCommands");
    const out = await dispatchCommand(`/approvelogin ${entry.id.slice(0, 8)}`);
    expect(out).toContain("✅");
    expect(out.toLowerCase()).toContain("approved");
    expect(out).toContain(entry.id.slice(0, 8));
    expect(getPendingLogin(entry.id)?.status).toBe("approved");
  });

  it("returns 'no longer pending' when re-approving an already-answered entry via a full-id lookup", async () => {
    const { createPendingLogin, answerPendingLogin } = await import("../loginApprovals");
    const entry = createPendingLogin(sampleArgs);
    answerPendingLogin(entry.id, "approved");
    // listPendingLogins() only returns status=pending, so the already-
    // answered entry no longer matches ANY prefix — the command should
    // report "no match", not silently re-approve.
    const { dispatchCommand } = await import("../telegramCommands");
    const out = await dispatchCommand(`/approvelogin ${entry.id.slice(0, 8)}`);
    expect(out).toMatch(/No pending login matching/i);
  });

  it("returns an ambiguity error listing previews when a prefix matches multiple pending logins", async () => {
    const fakeEntries = [
      makeEntry("aaaaaa1111111111"),
      makeEntry("aaaaaa2222222222"),
    ];
    vi.doMock("../loginApprovals", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../loginApprovals")>();
      return { ...actual, listPendingLogins: () => fakeEntries };
    });
    const { dispatchCommand } = await import("../telegramCommands");
    const out = await dispatchCommand("/approvelogin aaaaaa");
    expect(out).toMatch(/Ambiguous/i);
    expect(out).toContain(fakeEntries[0].id.slice(0, 12));
    expect(out).toContain(fakeEntries[1].id.slice(0, 12));
  });
});

describe("/denylogin", () => {
  it("resolves a unique prefix, flips status to denied, and confirms", async () => {
    const { createPendingLogin, getPendingLogin } = await import("../loginApprovals");
    const entry = createPendingLogin(sampleArgs);
    const { dispatchCommand } = await import("../telegramCommands");
    const out = await dispatchCommand(`/denylogin ${entry.id.slice(0, 8)}`);
    expect(out).toContain("🛑");
    expect(out.toLowerCase()).toContain("denied");
    expect(getPendingLogin(entry.id)?.status).toBe("denied");
  });

  it("mirrors /approvelogin's usage / too-short validation", async () => {
    const { dispatchCommand } = await import("../telegramCommands");
    expect(await dispatchCommand("/denylogin")).toMatch(/Usage:/);
    expect(await dispatchCommand("/denylogin abc")).toMatch(/too short/i);
  });
});

describe("/help lists the new commands", () => {
  it("includes /logins, /approvelogin, /denylogin", async () => {
    const { dispatchCommand } = await import("../telegramCommands");
    const help = await dispatchCommand("/help");
    expect(help).toContain("/logins");
    expect(help).toContain("/approvelogin");
    expect(help).toContain("/denylogin");
  });
});

describe("pending-login notifier hook", () => {
  it("subscribeLoginApprovals fires with the new entry when createPendingLogin is called", async () => {
    const { createPendingLogin, subscribeLoginApprovals } = await import("../loginApprovals");
    const seen: PendingLogin[] = [];
    const unsubscribe = subscribeLoginApprovals((entry) => seen.push(entry));
    try {
      const entry = createPendingLogin(sampleArgs);
      expect(seen).toHaveLength(1);
      expect(seen[0].id).toBe(entry.id);
      expect(seen[0].userAgent).toBe(sampleArgs.userAgent);
    } finally {
      unsubscribe();
    }
  });

  it("stops delivering events after unsubscribe", async () => {
    const { createPendingLogin, subscribeLoginApprovals } = await import("../loginApprovals");
    const seen: PendingLogin[] = [];
    const unsubscribe = subscribeLoginApprovals((entry) => seen.push(entry));
    unsubscribe();
    createPendingLogin(sampleArgs);
    expect(seen).toHaveLength(0);
  });
});

describe("renderPendingLoginMessage", () => {
  it("includes the UA, IP, and an /approvelogin command with the id prefix", async () => {
    const { renderPendingLoginMessage } = await import("../telegramNotifier");
    const entry = makeEntry("0123456789abcdef", {
      userAgent: "Mozilla/5.0 iPhone",
      remoteIp: "198.51.100.7",
    });
    const out = renderPendingLoginMessage(entry);
    expect(out).toContain("New device login pending");
    expect(out).toContain("iPhone");
    // IP dots are MarkdownV2-escaped (`\.`) by `escapeMarkdownV2`.
    expect(out).toMatch(/198\\?\.51\\?\.100\\?\.7/);
    expect(out).toContain("/approvelogin");
    expect(out).toContain(entry.id.slice(0, 8));
  });
});
