import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, resetHarness } from "./hookHarness";
import type { LogEntry } from "../helpers";

// Swap React's hook primitives for the dependency-free harness. The factory
// uses a dynamic import (not the static one above) because vi.mock is hoisted
// above imports; both resolve to the same module instance, so `renderHook`
// and the mocked hooks share state.
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

import { useChatSearch } from "../useChatSearch";

const logRef = { current: null as HTMLDivElement | null };

function userEntry(uuid: string, content: string): LogEntry {
  return { type: "user", uuid, message: { content } };
}

beforeEach(() => {
  resetHarness();
});

describe("useChatSearch — match collection", () => {
  it("has no matches for the initial empty query", () => {
    const entries = [userEntry("a", "Hello World"), userEntry("b", "bye")];
    const { result } = renderHook(() => useChatSearch(entries, logRef));
    expect(result.current.searchQuery).toBe("");
    expect(result.current.matchedKeys).toEqual([]);
    expect(result.current.searchIndex).toHaveLength(2);
  });

  it("collects the keys of entries whose content includes the query", () => {
    const entries = [
      userEntry("a", "Hello World"),
      userEntry("b", "goodbye"),
      userEntry("c", "hello again"),
    ];
    const { result } = renderHook(() => useChatSearch(entries, logRef));
    act(() => result.current.setSearchQuery("hello"));
    expect(result.current.matchedKeys).toEqual(["a", "c"]);
  });

  it("trims and lower-cases the query before matching", () => {
    const entries = [userEntry("a", "Hello"), userEntry("b", "world")];
    const { result } = renderHook(() => useChatSearch(entries, logRef));
    act(() => result.current.setSearchQuery("  HELLO  "));
    expect(result.current.matchedKeys).toEqual(["a"]);
  });

  it("returns no matches when the query matches nothing", () => {
    const entries = [userEntry("a", "Hello")];
    const { result } = renderHook(() => useChatSearch(entries, logRef));
    act(() => result.current.setSearchQuery("zzz"));
    expect(result.current.matchedKeys).toEqual([]);
  });

  it("stringifies non-string content so it is still searchable", () => {
    const entries: LogEntry[] = [
      { type: "assistant", uuid: "a", message: { content: [{ type: "text", text: "FOO" }] } },
    ];
    const { result } = renderHook(() => useChatSearch(entries, logRef));
    act(() => result.current.setSearchQuery("foo"));
    expect(result.current.matchedKeys).toEqual(["a"]);
  });

  it("derives entry keys via uuid -> message.id -> timestamp -> position", () => {
    const entries: LogEntry[] = [
      { type: "user", uuid: "u1", message: { content: "x" } },
      { type: "user", message: { id: "m2", content: "x" } },
      { type: "assistant", timestamp: "2026-01-01T00:00:00Z", message: { content: "x" } },
      { message: { content: "x" } },
    ];
    const { result } = renderHook(() => useChatSearch(entries, logRef));
    expect(result.current.searchIndex.map((s) => s.key)).toEqual([
      "u1",
      "m2",
      "2026-01-01T00:00:00Z:assistant",
      "pos-3",
    ]);
  });
});

describe("useChatSearch — next/prev navigation", () => {
  const threeMatches = () => [
    userEntry("a", "x"),
    userEntry("b", "x"),
    userEntry("c", "x"),
  ];

  it("next() advances the index and wraps past the end", () => {
    const { result } = renderHook(() => useChatSearch(threeMatches(), logRef));
    act(() => result.current.setSearchQuery("x"));
    expect(result.current.matchIdx).toBe(0);
    act(() => result.current.next());
    expect(result.current.matchIdx).toBe(1);
    act(() => result.current.next());
    expect(result.current.matchIdx).toBe(2);
    act(() => result.current.next());
    expect(result.current.matchIdx).toBe(0); // wrapped
  });

  it("prev() steps backward and wraps past the start", () => {
    const { result } = renderHook(() => useChatSearch(threeMatches(), logRef));
    act(() => result.current.setSearchQuery("x"));
    act(() => result.current.prev());
    expect(result.current.matchIdx).toBe(2); // wrapped from 0
    act(() => result.current.prev());
    expect(result.current.matchIdx).toBe(1);
  });

  it("next()/prev() are no-ops when there are no matches", () => {
    const { result } = renderHook(() => useChatSearch(threeMatches(), logRef));
    act(() => result.current.next());
    act(() => result.current.prev());
    expect(result.current.matchIdx).toBe(0);
  });

  it("resets the match index to 0 when the query changes", () => {
    const entries = [userEntry("a", "xy"), userEntry("b", "xy"), userEntry("c", "xy")];
    const { result } = renderHook(() => useChatSearch(entries, logRef));
    act(() => result.current.setSearchQuery("x"));
    act(() => result.current.next());
    act(() => result.current.next());
    expect(result.current.matchIdx).toBe(2);
    act(() => result.current.setSearchQuery("xy"));
    expect(result.current.matchIdx).toBe(0);
    expect(result.current.matchedKeys).toEqual(["a", "b", "c"]);
  });
});

describe("useChatSearch — open/close", () => {
  it("toggles searchOpen", () => {
    const { result } = renderHook(() => useChatSearch([], logRef));
    expect(result.current.searchOpen).toBe(false);
    act(() => result.current.open());
    expect(result.current.searchOpen).toBe(true);
    act(() => result.current.close());
    expect(result.current.searchOpen).toBe(false);
  });
});
