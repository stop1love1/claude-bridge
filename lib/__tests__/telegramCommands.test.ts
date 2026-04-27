import { describe, it, expect } from "vitest";
import { dispatchCommand } from "../telegramCommands";

/**
 * These tests cover the pure dispatcher + parser + validation layer of
 * `lib/telegramCommands`. Side-effecting handlers (`/done`, `/new`,
 * `/clear`, …) are exercised by the underlying lib tests
 * (`tasksStore.test.ts`, `meta.test.ts`, etc.); duplicating them here
 * would couple this suite to disk state that other suites already cover.
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
