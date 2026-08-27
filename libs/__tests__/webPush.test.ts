import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const generateVAPIDKeys = vi.fn();
const setVapidDetails = vi.fn();
const sendNotification = vi.fn();

vi.mock("web-push", () => ({
  generateVAPIDKeys: (...args: unknown[]) => generateVAPIDKeys(...args),
  setVapidDetails: (...args: unknown[]) => setVapidDetails(...args),
  sendNotification: (...args: unknown[]) => sendNotification(...args),
}));

let tempCwd: string;

beforeEach(() => {
  tempCwd = mkdtempSync(join(tmpdir(), "bridge-webpush-test-"));
  vi.spyOn(process, "cwd").mockReturnValue(tempCwd);
  vi.resetModules();
  generateVAPIDKeys.mockReset();
  setVapidDetails.mockReset();
  sendNotification.mockReset();
  generateVAPIDKeys.mockReturnValue({ publicKey: "PUB", privateKey: "PRIV" });
});

afterEach(() => {
  vi.restoreAllMocks();
  try {
    rmSync(tempCwd, { recursive: true, force: true });
  } catch {
  }
});

const keysPath = () => join(tempCwd, ".bridge-state", "push-keys.json");
const subsPath = () => join(tempCwd, ".bridge-state", "push-subs.json");

describe("ensureVapidKeys", () => {
  it("generates + persists keys on first call (mode 0600) and reuses them on second", async () => {
    const { ensureVapidKeys } = await import("../webPush");
    const a = ensureVapidKeys();
    expect(a.publicKey).toBe("PUB");
    expect(generateVAPIDKeys).toHaveBeenCalledTimes(1);

    expect(existsSync(keysPath())).toBe(true);
    const onDisk = JSON.parse(readFileSync(keysPath(), "utf8"));
    expect(onDisk.publicKey).toBe("PUB");
    expect(onDisk.privateKey).toBe("PRIV");
    if (process.platform !== "win32") {
      const mode = statSync(keysPath()).mode & 0o777;
      expect(mode).toBe(0o600);
    }

    const b = ensureVapidKeys();
    expect(b.publicKey).toBe("PUB");
    expect(generateVAPIDKeys).toHaveBeenCalledTimes(1);
  });

  it("never returns the private key", async () => {
    const { ensureVapidKeys } = await import("../webPush");
    const result = ensureVapidKeys() as unknown as Record<string, unknown>;
    expect(result.privateKey).toBeUndefined();
  });

  it("regenerates when the on-disk keys file is corrupt", async () => {
    const { ensureVapidKeys } = await import("../webPush");
    ensureVapidKeys();
    writeFileSync(keysPath(), "not json");
    generateVAPIDKeys.mockReturnValue({ publicKey: "PUB2", privateKey: "PRIV2" });
    const b = ensureVapidKeys();
    expect(b.publicKey).toBe("PUB2");
    expect(generateVAPIDKeys).toHaveBeenCalledTimes(2);
  });
});

describe("addSubscription / removeSubscription", () => {
  const sub = {
    endpoint: "https://push.example.com/abc",
    keys: { p256dh: "p256key", auth: "authsecret" },
  };

  it("round-trips a subscription to disk", async () => {
    const { addSubscription, subscriptionCount } = await import("../webPush");
    addSubscription(sub);
    expect(subscriptionCount()).toBe(1);

    expect(existsSync(subsPath())).toBe(true);
    const onDisk = JSON.parse(readFileSync(subsPath(), "utf8"));
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0].endpoint).toBe(sub.endpoint);
    expect(onDisk[0].keys).toEqual(sub.keys);
  });

  it("is idempotent on the same endpoint (overwrite, no duplicates)", async () => {
    const { addSubscription, subscriptionCount } = await import("../webPush");
    addSubscription(sub);
    addSubscription({ ...sub, keys: { p256dh: "changed", auth: "changed" } });
    expect(subscriptionCount()).toBe(1);
    const onDisk = JSON.parse(readFileSync(subsPath(), "utf8"));
    expect(onDisk[0].keys.p256dh).toBe("changed");
  });

  it("ignores malformed subscriptions", async () => {
    const { addSubscription, subscriptionCount } = await import("../webPush");
    // @ts-expect-error deliberately malformed input
    addSubscription({ endpoint: "x" });
    // @ts-expect-error deliberately malformed input
    addSubscription(null);
    expect(subscriptionCount()).toBe(0);
  });

  it("removes a subscription by endpoint", async () => {
    const { addSubscription, removeSubscription, subscriptionCount } = await import("../webPush");
    addSubscription(sub);
    removeSubscription(sub.endpoint);
    expect(subscriptionCount()).toBe(0);
  });

  it("no-ops removing an endpoint that was never subscribed", async () => {
    const { removeSubscription, subscriptionCount } = await import("../webPush");
    expect(() => removeSubscription("https://nope.example.com")).not.toThrow();
    expect(subscriptionCount()).toBe(0);
  });
});

describe("sendPushToAll", () => {
  const subA = { endpoint: "https://push.example.com/a", keys: { p256dh: "pa", auth: "aa" } };
  const subB = { endpoint: "https://push.example.com/b", keys: { p256dh: "pb", auth: "ab" } };

  it("no-ops with zero subscribers (never touches web-push)", async () => {
    const { sendPushToAll } = await import("../webPush");
    await sendPushToAll({ title: "t", body: "b" });
    expect(sendNotification).not.toHaveBeenCalled();
    expect(setVapidDetails).not.toHaveBeenCalled();
  });

  it("sends to every subscriber after setting vapid details", async () => {
    const { addSubscription, sendPushToAll } = await import("../webPush");
    addSubscription(subA);
    addSubscription(subB);
    sendNotification.mockResolvedValue({ statusCode: 201, body: "", headers: {} });

    await sendPushToAll({ title: "Hi", body: "Body", url: "/tasks/t_1" });

    expect(setVapidDetails).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledTimes(2);
    const [subArg, payloadArg] = sendNotification.mock.calls[0] as [
      { endpoint: string },
      string,
    ];
    expect([subA.endpoint, subB.endpoint]).toContain(subArg.endpoint);
    expect(JSON.parse(payloadArg)).toEqual({ title: "Hi", body: "Body", url: "/tasks/t_1" });
  });

  it("prunes subscriptions that come back 404/410", async () => {
    const { addSubscription, sendPushToAll, subscriptionCount } = await import("../webPush");
    addSubscription(subA);
    addSubscription(subB);
    sendNotification.mockImplementation(async (sub: { endpoint: string }) => {
      if (sub.endpoint === subA.endpoint) {
        const err = new Error("gone") as Error & { statusCode: number };
        err.statusCode = 410;
        throw err;
      }
      return { statusCode: 201, body: "", headers: {} };
    });

    await sendPushToAll({ title: "Hi", body: "Body" });
    expect(subscriptionCount()).toBe(1);
    const onDisk = JSON.parse(readFileSync(subsPath(), "utf8"));
    expect(onDisk[0].endpoint).toBe(subB.endpoint);
  });

  it("keeps non-404/410 failures subscribed and never rejects", async () => {
    const { addSubscription, sendPushToAll, subscriptionCount } = await import("../webPush");
    addSubscription(subA);
    sendNotification.mockRejectedValue(
      Object.assign(new Error("server error"), { statusCode: 500 }),
    );
    await expect(sendPushToAll({ title: "t", body: "b" })).resolves.toBeUndefined();
    expect(subscriptionCount()).toBe(1);
  });

  it("never throws even if web-push itself explodes synchronously", async () => {
    const { addSubscription, sendPushToAll } = await import("../webPush");
    addSubscription(subA);
    setVapidDetails.mockImplementation(() => {
      throw new Error("boom");
    });
    await expect(sendPushToAll({ title: "t", body: "b" })).resolves.toBeUndefined();
  });
});
