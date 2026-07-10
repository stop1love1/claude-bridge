import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { extractTunnelUrl } from "../tunnels";

describe("extractTunnelUrl — ngrok", () => {
  it("extracts the URL from the success log line", () => {
    const line =
      't=2024-04-29T12:00:00 lvl=info msg="started tunnel" name=command_line addr=http://localhost:7777 url=https://abc-123.ngrok-free.app';
    expect(extractTunnelUrl("ngrok", line)).toBe("https://abc-123.ngrok-free.app");
  });

  it("does NOT match an error line that happens to contain the URL", () => {
    // The triage scenario: stderr error line carrying the URL inside
    // an error message. With the success-cue gate this must NOT flip
    // the tunnel into status=running.
    const line =
      't=2024-04-29T12:00:00 lvl=eror msg="failed to start tunnel" url=https://abc-123.ngrok-free.app err="auth failed"';
    expect(extractTunnelUrl("ngrok", line)).toBeNull();
  });

  it("does not match a bare URL with no msg= cue", () => {
    expect(extractTunnelUrl("ngrok", "https://abc.ngrok-free.app is up")).toBeNull();
  });

  it("returns null for empty / non-string lines", () => {
    expect(extractTunnelUrl("ngrok", "")).toBeNull();
    expect(extractTunnelUrl("ngrok", null as unknown as string)).toBeNull();
  });
});

describe("extractTunnelUrl — localtunnel", () => {
  it("extracts the URL after the success preamble", () => {
    const line = "your url is: https://shaggy-radios-watch.loca.lt";
    expect(extractTunnelUrl("localtunnel", line)).toBe(
      "https://shaggy-radios-watch.loca.lt",
    );
  });

  it("does NOT match a bare URL on its own line", () => {
    expect(extractTunnelUrl("localtunnel", "https://shaggy-radios-watch.loca.lt"))
      .toBeNull();
  });

  it("does NOT match an error line referencing the URL", () => {
    expect(
      extractTunnelUrl(
        "localtunnel",
        "ERROR: tunnel https://shaggy-radios-watch.loca.lt is dead",
      ),
    ).toBeNull();
  });
});

/**
 * Tunnel → `bridge.json#publicUrl` wiring + auto-start settings.
 *
 * Follows the `homedir()`-redirect + `resetModules` + fresh-dynamic-
 * import convention from `auth.test.ts` / `childRetry.test.ts` so these
 * tests read/write a temp `bridge.json`, never the operator's real one.
 * `node:child_process#spawn` is mocked per-test via `vi.doMock` (not the
 * hoisted `vi.mock`, since we need a fresh fake child per test after
 * `resetModules`) so `startTunnel` never shells out to a real
 * localtunnel/ngrok process — we drive its stdout/stderr by hand.
 */
describe("tunnel → publicUrl wiring", () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let originalBridgePort: string | undefined;
  let createdIds: string[];

  function makeFakeChild(): ChildProcess {
    const stdout = new EventEmitter() as unknown as ChildProcess["stdout"] & EventEmitter;
    (stdout as unknown as { setEncoding: (enc: string) => void }).setEncoding = () => {};
    const stderr = new EventEmitter() as unknown as ChildProcess["stderr"] & EventEmitter;
    (stderr as unknown as { setEncoding: (enc: string) => void }).setEncoding = () => {};
    const child = new EventEmitter() as unknown as ChildProcess;
    (child as unknown as { stdout: unknown }).stdout = stdout;
    (child as unknown as { stderr: unknown }).stderr = stderr;
    (child as unknown as { pid: number | undefined }).pid = undefined;
    (child as unknown as { exitCode: number | null }).exitCode = null;
    (child as unknown as { signalCode: string | null }).signalCode = null;
    (child as unknown as { kill: () => boolean }).kill = () => true;
    return child;
  }

  async function mockSpawn(): Promise<ChildProcess> {
    const fakeChild = makeFakeChild();
    vi.doMock("node:child_process", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:child_process")>();
      return { ...actual, spawn: vi.fn(() => fakeChild) };
    });
    return fakeChild;
  }

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "bridge-tunnels-test-"));
    originalHome = process.env.HOME;
    originalBridgePort = process.env.BRIDGE_PORT;
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    process.env.BRIDGE_PORT = "7777";
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    vi.spyOn(require("node:os"), "homedir").mockReturnValue(tempHome);
    vi.resetModules();
    createdIds = [];
  });

  afterEach(async () => {
    try {
      const { removeTunnel } = await import("../tunnels");
      for (const id of createdIds) {
        try { removeTunnel(id); } catch { /* best-effort */ }
      }
    } catch { /* module may have failed to load in a given test */ }
    vi.restoreAllMocks();
    vi.resetModules();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalBridgePort === undefined) delete process.env.BRIDGE_PORT;
    else process.env.BRIDGE_PORT = originalBridgePort;
    try { rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("flips publicUrl when a tunnel on the bridge port starts running (stdout, localtunnel)", async () => {
    const fakeChild = await mockSpawn();
    const { startTunnel } = await import("../tunnels");
    const { getManifestPublicUrl } = await import("../apps");

    const entry = startTunnel({ port: 7777, provider: "localtunnel" });
    createdIds.push(entry.id);
    expect(getManifestPublicUrl()).toBe("");

    (fakeChild.stdout as unknown as EventEmitter).emit(
      "data",
      "your url is: https://abc-123.loca.lt\n",
    );

    expect(getManifestPublicUrl()).toBe("https://abc-123.loca.lt");
  });

  it("flips publicUrl when a tunnel on the bridge port starts running (stderr, ngrok)", async () => {
    const fakeChild = await mockSpawn();
    const { setNgrokAuthtoken, startTunnel } = await import("../tunnels");
    const { getManifestPublicUrl } = await import("../apps");
    setNgrokAuthtoken("fake-token-for-test");

    const entry = startTunnel({ port: 7777, provider: "ngrok" });
    createdIds.push(entry.id);

    (fakeChild.stderr as unknown as EventEmitter).emit(
      "data",
      't=2024-04-29T12:00:00 lvl=info msg="started tunnel" name=command_line addr=http://localhost:7777 url=https://abc-123.ngrok-free.app\n',
    );

    expect(getManifestPublicUrl()).toBe("https://abc-123.ngrok-free.app");
  });

  it("does NOT touch publicUrl for a tunnel on a non-bridge port", async () => {
    const fakeChild = await mockSpawn();
    const { startTunnel } = await import("../tunnels");
    const { getManifestPublicUrl, setManifestPublicUrl } = await import("../apps");
    setManifestPublicUrl("https://existing.example.com");

    const entry = startTunnel({ port: 3000, provider: "localtunnel" });
    createdIds.push(entry.id);

    (fakeChild.stdout as unknown as EventEmitter).emit(
      "data",
      "your url is: https://abc-123.loca.lt\n",
    );

    expect(getManifestPublicUrl()).toBe("https://existing.example.com");
  });

  it("clears publicUrl when the serving tunnel stops (stopTunnel) and publicUrl is unchanged", async () => {
    const fakeChild = await mockSpawn();
    const { startTunnel, stopTunnel } = await import("../tunnels");
    const { getManifestPublicUrl } = await import("../apps");

    const entry = startTunnel({ port: 7777, provider: "localtunnel" });
    createdIds.push(entry.id);
    (fakeChild.stdout as unknown as EventEmitter).emit(
      "data",
      "your url is: https://abc-123.loca.lt\n",
    );
    expect(getManifestPublicUrl()).toBe("https://abc-123.loca.lt");

    stopTunnel(entry.id);

    expect(getManifestPublicUrl()).toBe("");
  });

  it("leaves publicUrl alone on stop if the operator changed it meanwhile", async () => {
    const fakeChild = await mockSpawn();
    const { startTunnel, stopTunnel } = await import("../tunnels");
    const { getManifestPublicUrl, setManifestPublicUrl } = await import("../apps");

    const entry = startTunnel({ port: 7777, provider: "localtunnel" });
    createdIds.push(entry.id);
    (fakeChild.stdout as unknown as EventEmitter).emit(
      "data",
      "your url is: https://abc-123.loca.lt\n",
    );
    expect(getManifestPublicUrl()).toBe("https://abc-123.loca.lt");

    setManifestPublicUrl("https://operator-set.example.com");
    stopTunnel(entry.id);

    expect(getManifestPublicUrl()).toBe("https://operator-set.example.com");
  });

  it("clears publicUrl via removeTunnel when the tunnel is purged without an explicit stop", async () => {
    const fakeChild = await mockSpawn();
    const { startTunnel, removeTunnel } = await import("../tunnels");
    const { getManifestPublicUrl } = await import("../apps");

    const entry = startTunnel({ port: 7777, provider: "localtunnel" });
    createdIds.push(entry.id);
    (fakeChild.stdout as unknown as EventEmitter).emit(
      "data",
      "your url is: https://abc-123.loca.lt\n",
    );
    expect(getManifestPublicUrl()).toBe("https://abc-123.loca.lt");

    removeTunnel(entry.id);
    createdIds = createdIds.filter((id) => id !== entry.id);

    expect(getManifestPublicUrl()).toBe("");
  });

  it("clears publicUrl via killAllTunnels for a live serving tunnel", async () => {
    const fakeChild = await mockSpawn();
    const { startTunnel, killAllTunnels } = await import("../tunnels");
    const { getManifestPublicUrl } = await import("../apps");

    const entry = startTunnel({ port: 7777, provider: "localtunnel" });
    createdIds.push(entry.id);
    (fakeChild.stdout as unknown as EventEmitter).emit(
      "data",
      "your url is: https://abc-123.loca.lt\n",
    );
    expect(getManifestPublicUrl()).toBe("https://abc-123.loca.lt");

    killAllTunnels();

    expect(getManifestPublicUrl()).toBe("");
  });
});

describe("getTunnelAutoStart / setTunnelAutoStart", () => {
  let tempHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "bridge-tunnels-autostart-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    vi.spyOn(require("node:os"), "homedir").mockReturnValue(tempHome);
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    try { rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("returns null when unset", async () => {
    const { getTunnelAutoStart } = await import("../apps");
    expect(getTunnelAutoStart()).toBeNull();
  });

  it("round-trips enabled/provider/port through bridge.json", async () => {
    const { getTunnelAutoStart, setTunnelAutoStart } = await import("../apps");
    setTunnelAutoStart({ enabled: true, provider: "ngrok", port: 4040 });
    expect(getTunnelAutoStart()).toEqual({ enabled: true, provider: "ngrok", port: 4040 });
  });

  it("clears back to null", async () => {
    const { getTunnelAutoStart, setTunnelAutoStart } = await import("../apps");
    setTunnelAutoStart({ enabled: true, provider: "localtunnel", port: 7777 });
    setTunnelAutoStart(null);
    expect(getTunnelAutoStart()).toBeNull();
  });

  it("preserves the sibling tunnels.ngrok.authtoken section on write", async () => {
    const { setNgrokAuthtoken, getNgrokAuthtoken } = await import("../tunnels");
    const { getTunnelAutoStart, setTunnelAutoStart } = await import("../apps");
    setNgrokAuthtoken("secret-token");
    setTunnelAutoStart({ enabled: true, provider: "ngrok", port: 4040 });
    expect(getNgrokAuthtoken()).toBe("secret-token");
    expect(getTunnelAutoStart()).toEqual({ enabled: true, provider: "ngrok", port: 4040 });
  });
});
