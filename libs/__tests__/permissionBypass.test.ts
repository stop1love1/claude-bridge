import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

/**
 * Proves the whole chain the permission hook walks, at the routes themselves:
 *
 *   composer sends a message with "skip permissions"
 *     -> hook announces a tool call   (POST /permission)
 *     -> hook long-polls the decision (GET  /permission/<rid>)
 *
 * A 200 + "allow" on that poll is what makes the hook exit without drawing the
 * popup; a 202 is what leaves the popup on screen.
 */

const TMP_SESSIONS = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require("node:path") as typeof import("node:path");
  return mkdtempSync(join(tmpdir(), "bridge-bypass-sessions-"));
});

const TMP_PROJECT_DIR = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require("node:path") as typeof import("node:path");
  return mkdtempSync(join(tmpdir(), "bridge-bypass-project-"));
});

// Flipped per test: false = idle session, true = a turn already in flight.
const aliveRef = vi.hoisted(() => ({ value: false }));
const liveSendRef = vi.hoisted(() => ({ value: false }));

vi.mock("../paths", async () => {
  const actual = await vi.importActual<typeof import("../paths")>("../paths");
  return { ...actual, SESSIONS_DIR: TMP_SESSIONS };
});
vi.mock("../auth", () => ({
  verifyRequestActor: () => null,
  verifyRequestAuth: () => ({ sub: "op", exp: Number.MAX_SAFE_INTEGER }),
}));
vi.mock("../sessions", () => ({ projectDirFor: () => TMP_PROJECT_DIR }));
vi.mock("../sessionEvents", () => ({ isAlive: () => aliveRef.value }));
vi.mock("../guestSessionRepo", () => ({
  guestBoundRepoValue: (args: { callerValue: string | null }) => args.callerValue,
}));
vi.mock("../repos", () => ({ resolveRepoCwd: () => "/tmp/fake-bypass-repo" }));
vi.mock("../permissionSettings", () => ({
  writeSessionSettings: (p: string) => p,
  freeSessionSettingsPath: (sid: string) => `settings-${sid}.json`,
}));
vi.mock("../tasksStore", () => ({
  findTaskBySessionId: () => null,
  updateTask: vi.fn(),
}));
vi.mock("../spawn", () => ({
  // Default to "no live child", which is what an orphan or already-exited
  // session looks like, so these cases exercise the queue fallback.
  sendToLiveSession: () => liveSendRef.value,
  resumeClaude: () => new EventEmitter() as unknown as ChildProcess,
  spawnFreeSession: (
    _cwd: string,
    _p: string,
    _s: unknown,
    _sp: string,
    sessionId: string,
  ) => ({ child: new EventEmitter() as unknown as ChildProcess, sessionId }),
  waitEarlyFailure: async () => null,
}));

const SESSION = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

function rid(n: number): string {
  return `cccccccc-3333-4333-8333-cccccccc000${n}`;
}

async function sendMessage(sessionId: string, mode?: string) {
  const { POST } = await import("@/app/api/sessions/[sessionId]/message/route");
  const req = new Request(`http://localhost:7777/api/sessions/${sessionId}/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message: "hi",
      repo: "fake",
      ...(mode ? { settings: { mode } } : {}),
    }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return POST(req as any, { params: Promise.resolve({ sessionId }) });
}

/** What the hook does first: announce the tool call it is about to make. */
async function announce(sessionId: string, requestId: string) {
  const { POST } = await import("@/app/api/sessions/[sessionId]/permission/route");
  const req = new Request(`http://localhost:7777/api/sessions/${sessionId}/permission`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestId, tool: "Edit", input: { file_path: "/x.ts" } }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return POST(req as any, { params: Promise.resolve({ sessionId }) });
}

/** What the hook does next: poll for the decision. */
async function poll(sessionId: string, requestId: string) {
  const { GET } = await import(
    "@/app/api/sessions/[sessionId]/permission/[requestId]/route"
  );
  const req = new Request(
    `http://localhost:7777/api/sessions/${sessionId}/permission/${requestId}`,
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await GET(req as any, {
    params: Promise.resolve({ sessionId, requestId }),
  });
  return { status: res.status, body: (await res.json()) as { status?: string } };
}

let previousAllowBypass: string | undefined;

beforeEach(async () => {
  aliveRef.value = false;
  liveSendRef.value = false;
  // The composer only offers "skip permissions" when the operator has opted in
  // with this variable, and the message route refuses the mode without it.
  previousAllowBypass = process.env.NEXT_PUBLIC_BRIDGE_ALLOW_BYPASS;
  process.env.NEXT_PUBLIC_BRIDGE_ALLOW_BYPASS = "1";
  const { _resetSessionBypassForTests } = await import("../sessionBypass");
  _resetSessionBypassForTests();
});

afterEach(() => {
  if (previousAllowBypass === undefined) delete process.env.NEXT_PUBLIC_BRIDGE_ALLOW_BYPASS;
  else process.env.NEXT_PUBLIC_BRIDGE_ALLOW_BYPASS = previousAllowBypass;
  vi.clearAllMocks();
});

describe("skip permissions — the popup the hook would draw", () => {
  it("keeps asking when the operator has not turned it on", async () => {
    await sendMessage(SESSION, "default");
    await announce(SESSION, rid(1));
    // 202 = still pending = the Allow/Deny popup stays up.
    expect(await poll(SESSION, rid(1))).toMatchObject({ status: 202 });
  });

  it("answers allow once the operator turns it on", async () => {
    await sendMessage(SESSION, "bypassPermissions");
    await announce(SESSION, rid(2));
    const r = await poll(SESSION, rid(2));
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("allow");
  });

  it("applies to a turn that is already running, which the env var cannot reach", async () => {
    // A live session queues the message instead of spawning, so no new process
    // is started and no environment variable is ever set — the case that used
    // to leave the popup on screen no matter what the toggle said. Queuing
    // needs both an existing transcript and a live process.
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    writeFileSync(join(TMP_PROJECT_DIR, `${SESSION}.jsonl`), "");
    aliveRef.value = true;
    const res = await sendMessage(SESSION, "bypassPermissions");
    expect(res.status).toBe(202); // queued, not spawned
    expect(await res.json()).toMatchObject({ queued: true });
    await announce(SESSION, rid(3));
    expect((await poll(SESSION, rid(3))).body.status).toBe("allow");
  });

  it("hands the message to the live process when there is one, instead of queuing it", async () => {
    // Same live session, but this time the bridge still owns the child. The
    // message should reach the turn already in flight rather than waiting for
    // it to end, which is the whole point of holding stdin open.
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    writeFileSync(join(TMP_PROJECT_DIR, `${SESSION}.jsonl`), "");
    aliveRef.value = true;
    liveSendRef.value = true;
    const res = await sendMessage(SESSION, "bypassPermissions");
    expect(res.status).toBe(202);
    const body = (await res.json()) as { delivered?: string; queued?: boolean };
    expect(body.delivered).toBe("live");
    expect(body.queued).toBeUndefined();
  });

  it("goes back to asking as soon as the operator unticks it", async () => {
    await sendMessage(SESSION, "bypassPermissions");
    await sendMessage(SESSION, "default");
    await announce(SESSION, rid(4));
    expect(await poll(SESSION, rid(4))).toMatchObject({ status: 202 });
  });

  it("does not leak the choice into another session", async () => {
    await sendMessage(SESSION, "bypassPermissions");
    await announce(OTHER, rid(5));
    expect(await poll(OTHER, rid(5))).toMatchObject({ status: 202 });
  });

  it("does not switch itself on when the caller sends no settings at all", async () => {
    // With ALLOW_BYPASS on, bypass is also the *fallback* spawn mode — reading
    // the flag from there would auto-approve for a client that simply omitted
    // settings, which is not a choice the operator made.
    await sendMessage(SESSION);
    await announce(SESSION, rid(6));
    expect(await poll(SESSION, rid(6))).toMatchObject({ status: 202 });
  });
});
