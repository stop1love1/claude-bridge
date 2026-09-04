import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act, resetHarness } from "./hookHarness";
import type { LogEntry } from "../helpers";

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  const h = await import("./hookHarness");
  return {
    ...actual,
    useState: h.useState,
    useRef: h.useRef,
    useMemo: h.useMemo,
    useCallback: h.useCallback,
    useEffect: h.useEffect,
    useLayoutEffect: h.useLayoutEffect,
  };
});

import { useScrollManager } from "../useScrollManager";

interface ScrollMetrics {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

function userEntry(uuid: string, content: string): LogEntry {
  return { type: "user", uuid, message: { content } };
}

// Builds the argument bundle useScrollManager expects, with a mutable fake
// scroll element so tests can move the viewport between handleScroll calls.
function setup(opts: {
  visible?: LogEntry[];
  metrics?: Partial<ScrollMetrics>;
  firstOffset?: number | null;
  inFlight?: boolean;
}) {
  const el: ScrollMetrics = {
    scrollHeight: 1000,
    scrollTop: 0,
    clientHeight: 500,
    ...opts.metrics,
  };
  const logRef = { current: el as unknown as HTMLDivElement };
  const pendingScrollRestoreRef = {
    current: null as { prevHeight: number; prevTop: number } | null,
  };
  const firstOffsetRef = { current: opts.firstOffset ?? null };
  const inFlightOlderRef = { current: opts.inFlight ?? false };
  const loadOlder = vi.fn();
  const view = renderHook(() =>
    useScrollManager(
      [],
      opts.visible ?? [],
      logRef,
      pendingScrollRestoreRef,
      firstOffsetRef,
      inFlightOlderRef,
      loadOlder,
    ),
  );
  return { view, el, loadOlder, firstOffsetRef, inFlightOlderRef };
}

beforeEach(() => {
  resetHarness();
  // handleScroll -> schedulePinnedRecalc -> requestAnimationFrame, which is
  // undefined in the node test environment. Stub it to a no-op (the pinned
  // recompute it would run needs real layout, which is out of scope here).
  vi.stubGlobal("requestAnimationFrame", () => 0);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useScrollManager — stick-to-bottom transitions", () => {
  it("starts stuck to the bottom", () => {
    const { view } = setup({});
    expect(view.result.current.autoScroll).toBe(true);
  });

  it("turns autoScroll OFF when the user scrolls away from the bottom", () => {
    // gap = 1000 - 100 - 500 = 400 >= 40 -> not at bottom
    const { view } = setup({ metrics: { scrollHeight: 1000, scrollTop: 100, clientHeight: 500 } });
    act(() => view.result.current.handleScroll());
    expect(view.result.current.autoScroll).toBe(false);
  });

  it("turns autoScroll back ON when scrolled near the bottom", () => {
    const { view, el } = setup({ metrics: { scrollHeight: 1000, scrollTop: 100, clientHeight: 500 } });
    act(() => view.result.current.handleScroll());
    expect(view.result.current.autoScroll).toBe(false);
    el.scrollTop = 470; // gap = 1000 - 470 - 500 = 30 < 40 -> at bottom
    act(() => view.result.current.handleScroll());
    expect(view.result.current.autoScroll).toBe(true);
  });

  it("scrollToBottom pins scrollTop to the bottom and re-enables autoScroll", () => {
    const { view, el } = setup({ metrics: { scrollHeight: 1000, scrollTop: 100, clientHeight: 500 } });
    act(() => view.result.current.handleScroll());
    expect(view.result.current.autoScroll).toBe(false);
    act(() => view.result.current.scrollToBottom());
    expect(el.scrollTop).toBe(1000);
    expect(view.result.current.autoScroll).toBe(true);
  });
});

describe("useScrollManager — loading older history at the top", () => {
  it("requests older history when scrolled to the very top with more above", () => {
    const { view, loadOlder } = setup({
      metrics: { scrollTop: 0 },
      firstOffset: 25,
      inFlight: false,
    });
    act(() => view.result.current.handleScroll());
    expect(loadOlder).toHaveBeenCalledTimes(1);
  });

  it("does not request older history while a load is already in flight", () => {
    const { view, loadOlder } = setup({
      metrics: { scrollTop: 0 },
      firstOffset: 25,
      inFlight: true,
    });
    act(() => view.result.current.handleScroll());
    expect(loadOlder).not.toHaveBeenCalled();
  });

  it("does not request older history when there is nothing above", () => {
    const { view, loadOlder } = setup({
      metrics: { scrollTop: 0 },
      firstOffset: 0,
    });
    act(() => view.result.current.handleScroll());
    expect(loadOlder).not.toHaveBeenCalled();
  });
});

describe("useScrollManager — pinned user text", () => {
  it("shows the latest user message while stuck to the bottom", () => {
    const { view } = setup({ visible: [userEntry("u1", "first"), userEntry("u2", "second")] });
    expect(view.result.current.pinnedUserText).toBe("second");
  });

  it("is empty when there are no user messages", () => {
    const { view } = setup({
      visible: [{ type: "assistant", uuid: "a1", message: { content: "reply" } }],
    });
    expect(view.result.current.pinnedUserText).toBe("");
  });

  it("pins to the scrolled-past user message once scrolled away", () => {
    const entries = [
      userEntry("u1", "first message"),
      { type: "assistant", uuid: "a1", message: { content: "reply" } } as LogEntry,
      userEntry("u2", "second message"),
    ];
    const { view } = setup({
      visible: entries,
      metrics: { scrollHeight: 1000, scrollTop: 100, clientHeight: 500 },
    });
    expect(view.result.current.pinnedUserText).toBe("second message");
    act(() => view.result.current.handleScroll()); // scroll away -> autoScroll off
    act(() => view.result.current.setPinnedUserUuid("u1"));
    expect(view.result.current.pinnedUserText).toBe("first message");
  });
});
