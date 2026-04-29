import { describe, expect, it } from "vitest";
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
