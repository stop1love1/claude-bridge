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

describe("extractTunnelUrl — cloudflared", () => {
  // Lines below are copied verbatim from `cloudflared tunnel --url` 2025.7.0.
  it("extracts the URL from the quick-tunnel banner box", () => {
    const line =
      "2026-08-28T15:16:05Z INF |  https://birds-vampire-bottles-genome.trycloudflare.com                                    |";
    expect(extractTunnelUrl("cloudflared", line)).toBe(
      "https://birds-vampire-bottles-genome.trycloudflare.com",
    );
  });

  it("does NOT match the account-less warning banner, which links cloudflare.com", () => {
    const line =
      "2026-08-28T15:15:59Z INF Thank you for trying Cloudflare Tunnel. Doing so, without a Cloudflare account, is a quick way to experiment and try it out. However, be aware that these account-less Tunnels have no uptime guarantee, are subject to the Cloudflare Online Services Terms of Use (https://www.cloudflare.com/website-terms/), and Cloudflare reserves the right to investigate your use of Tunnels for violations of such terms. If you intend to use Tunnels in production you should use a pre-created named tunnel by following: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps";
    expect(extractTunnelUrl("cloudflared", line)).toBeNull();
  });

  it("does NOT match the bare hostname in the 'Requesting new quick Tunnel' line", () => {
    const line =
      "2026-08-28T15:15:59Z INF Requesting new quick Tunnel on trycloudflare.com...";
    expect(extractTunnelUrl("cloudflared", line)).toBeNull();
  });

  it("returns null for empty / non-string lines", () => {
    expect(extractTunnelUrl("cloudflared", "")).toBeNull();
    expect(extractTunnelUrl("cloudflared", null as unknown as string)).toBeNull();
  });
});

describe("startTunnel — provider validation", () => {
  it("refuses a custom subdomain for cloudflared (quick tunnels are randomly named)", async () => {
    const { startTunnel } = await import("../tunnels");
    expect(() =>
      startTunnel({ port: 7777, provider: "cloudflared", subdomain: "my-bridge" }),
    ).toThrow(/only supported for localtunnel/i);
  });

  it("still refuses an unknown provider", async () => {
    const { startTunnel } = await import("../tunnels");
    expect(() =>
      startTunnel({ port: 7777, provider: "frp" as never }),
    ).toThrow(/unknown provider/i);
  });
});

describe("installerPlan — per provider", () => {
  it("names the right package for whichever installer this platform offers", async () => {
    const { installerPlan } = await import("../tunnels");
    const expected = {
      ngrok: { winget: "Ngrok.Ngrok", brew: "ngrok/ngrok/ngrok", binary: "ngrok" },
      cloudflared: {
        winget: "Cloudflare.cloudflared",
        brew: "cloudflared",
        binary: "cloudflared",
      },
    } as const;

    for (const provider of ["ngrok", "cloudflared"] as const) {
      const plan = installerPlan(provider);
      const want = expected[provider];
      if (plan.kind === "winget") expect(plan.packageId).toBe(want.winget);
      else if (plan.kind === "brew") expect(plan.formula).toBe(want.brew);
      else if (plan.kind === "download") expect(plan.url).toContain(want.binary);
      else expect(plan.hint).toContain(provider);
    }
  });

  it("mentions the provider being installed in its hint, not a hardcoded ngrok", async () => {
    const { installerPlan } = await import("../tunnels");
    expect(installerPlan("cloudflared").hint.toLowerCase()).toContain("cloudflared");
    expect(installerPlan("cloudflared").hint.toLowerCase()).not.toContain("ngrok");
  });
});

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
        try { removeTunnel(id); } catch { }
      }
    } catch { }
    vi.restoreAllMocks();
    vi.resetModules();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalBridgePort === undefined) delete process.env.BRIDGE_PORT;
    else process.env.BRIDGE_PORT = originalBridgePort;
    try { rmSync(tempHome, { recursive: true, force: true }); } catch { }
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

  it("clears publicUrl when the serving tunnel's process exits on its own (crash path)", async () => {
    const fakeChild = await mockSpawn();
    const { startTunnel } = await import("../tunnels");
    const { getManifestPublicUrl } = await import("../apps");

    const entry = startTunnel({ port: 7777, provider: "localtunnel" });
    createdIds.push(entry.id);
    (fakeChild.stdout as unknown as EventEmitter).emit(
      "data",
      "your url is: https://abc-123.loca.lt\n",
    );
    expect(getManifestPublicUrl()).toBe("https://abc-123.loca.lt");

    (fakeChild as unknown as EventEmitter).emit("exit", 1, null);

    expect(getManifestPublicUrl()).toBe("");
  });

  it("leaves publicUrl alone on self-exit if the operator changed it meanwhile", async () => {
    const fakeChild = await mockSpawn();
    const { startTunnel } = await import("../tunnels");
    const { getManifestPublicUrl, setManifestPublicUrl } = await import("../apps");

    const entry = startTunnel({ port: 7777, provider: "localtunnel" });
    createdIds.push(entry.id);
    (fakeChild.stdout as unknown as EventEmitter).emit(
      "data",
      "your url is: https://abc-123.loca.lt\n",
    );
    expect(getManifestPublicUrl()).toBe("https://abc-123.loca.lt");

    setManifestPublicUrl("https://operator-set.example.com");
    (fakeChild as unknown as EventEmitter).emit("exit", 1, null);

    expect(getManifestPublicUrl()).toBe("https://operator-set.example.com");
  });

  it("maybeAutoStartTunnel spawns a tunnel with the configured port + provider when enabled", async () => {
    await mockSpawn();
    const { maybeAutoStartTunnel, listTunnels } = await import("../tunnels");
    const { setTunnelAutoStart } = await import("../apps");
    setTunnelAutoStart({ enabled: true, provider: "localtunnel", port: 7777 });

    await maybeAutoStartTunnel();

    const live = listTunnels().filter(
      (t) => t.status === "starting" || t.status === "running",
    );
    createdIds.push(...live.map((t) => t.id));
    expect(live).toHaveLength(1);
    expect(live[0].port).toBe(7777);
    expect(live[0].provider).toBe("localtunnel");
  });

  it("maybeAutoStartTunnel is a no-op when disabled or unset", async () => {
    await mockSpawn();
    const { maybeAutoStartTunnel, listTunnels } = await import("../tunnels");
    const { setTunnelAutoStart } = await import("../apps");

    await maybeAutoStartTunnel();
    expect(listTunnels()).toHaveLength(0);

    setTunnelAutoStart({ enabled: false, provider: "localtunnel", port: 7777 });
    await maybeAutoStartTunnel();
    expect(listTunnels()).toHaveLength(0);
  });

  it("maybeAutoStartTunnel catches + warns when startTunnel throws (never propagates)", async () => {
    await mockSpawn();
    const { maybeAutoStartTunnel, listTunnels } = await import("../tunnels");
    const { setTunnelAutoStart } = await import("../apps");
    setTunnelAutoStart({ enabled: true, provider: "ngrok", port: 7777 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(maybeAutoStartTunnel()).resolves.toBeUndefined();

    expect(listTunnels()).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/auto-start failed.*authtoken/),
    );
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
    try { rmSync(tempHome, { recursive: true, force: true }); } catch { }
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

  it("round-trips every provider the bridge can start, so a write is never silently dropped", async () => {
    const { getTunnelAutoStart, setTunnelAutoStart } = await import("../apps");
    const { TUNNEL_PROVIDERS } = await import("../tunnels");
    for (const provider of TUNNEL_PROVIDERS) {
      setTunnelAutoStart({ enabled: true, provider, port: 7777 });
      expect(getTunnelAutoStart()).toEqual({ enabled: true, provider, port: 7777 });
    }
  });

  it("still rejects a provider the bridge cannot start", async () => {
    const { getTunnelAutoStart, setTunnelAutoStart } = await import("../apps");
    setTunnelAutoStart({
      enabled: true,
      provider: "frp" as never,
      port: 7777,
    });
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
