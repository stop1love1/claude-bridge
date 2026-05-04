import { describe, expect, it } from "vitest";
import { consumePtyWsTicket, mintPtyWsTicket } from "../ptyWsTickets";

describe("ptyWsTickets", () => {
  it("mints and consumes once", () => {
    const t = mintPtyWsTicket("u@x");
    expect(consumePtyWsTicket(t)).toEqual({ ok: true, sub: "u@x" });
    expect(consumePtyWsTicket(t)).toEqual({ ok: false });
  });

  it("rejects unknown or empty", () => {
    expect(consumePtyWsTicket("")).toEqual({ ok: false });
    expect(consumePtyWsTicket(undefined)).toEqual({ ok: false });
    expect(consumePtyWsTicket("nope")).toEqual({ ok: false });
  });
});
