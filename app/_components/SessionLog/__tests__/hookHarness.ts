// Minimal, dependency-free React-hooks test harness.
//
// Why this exists: the repo has no @testing-library/react, no
// react-test-renderer, and no DOM test environment (jsdom / happy-dom)
// installed, and the task forbids adding dependencies. To drive the real
// SessionLog hooks (useChatSearch / useScrollManager) and observe their
// returned state across user actions, each hook test file swaps React's
// hook primitives with the implementations below via
//   vi.mock("react", ...) -> { ...actual, useState: h.useState, ... }
// and then renders the hook through `renderHook` here.
//
// Scope note: effects are deliberately NOT run. Every behaviour these tests
// assert (search match collection + wrap-around, autoscroll stick-to-bottom,
// derived pinned text) lives in render-phase state and useMemo, never inside
// an effect. Effect-driven, DOM-touching behaviour (Ctrl+F, smooth-scroll to
// a match, ResizeObserver/IntersectionObserver pinning) is out of scope
// precisely because it needs a DOM this environment does not provide.
//
// This file has no ".test." in its name, so Vitest's include glob does not
// collect it as a suite.

type StateSlot = { kind: "state"; state: unknown };
type RefSlot = { kind: "ref"; ref: { current: unknown } };
type MemoSlot = { kind: "memo"; value: unknown; deps: unknown[] | undefined };
type Slot = StateSlot | RefSlot | MemoSlot;

interface Instance {
  slots: Slot[];
  idx: number;
  rendering: boolean;
  renderPhaseUpdate: boolean;
  dirty: boolean;
  render: () => unknown;
  result: unknown;
  doRender: () => void;
}

const instances: Instance[] = [];
let current: Instance | null = null;

function requireInstance(): Instance {
  if (!current) throw new Error("React hook called outside renderHook()");
  return current;
}

function depsEqual(a: unknown[] | undefined, b: unknown[] | undefined): boolean {
  if (!a || !b) return false; // no deps array => recompute every render
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!Object.is(a[i], b[i])) return false;
  }
  return true;
}

export function useState<S>(
  initial: S | (() => S),
): [S, (u: S | ((prev: S) => S)) => void] {
  const inst = requireInstance();
  const i = inst.idx++;
  let slot = inst.slots[i] as StateSlot | undefined;
  if (!slot) {
    const init = typeof initial === "function" ? (initial as () => S)() : initial;
    slot = { kind: "state", state: init };
    inst.slots[i] = slot;
  }
  const s = slot;
  const setState = (u: S | ((prev: S) => S)): void => {
    const nextVal =
      typeof u === "function" ? (u as (prev: S) => S)(s.state as S) : u;
    if (Object.is(nextVal, s.state)) return; // React bails on unchanged state
    s.state = nextVal;
    if (inst.rendering) inst.renderPhaseUpdate = true; // render-phase update
    else inst.dirty = true; // schedule a re-render, flushed by act()
  };
  return [s.state as S, setState];
}

export function useRef<T>(initial: T): { current: T } {
  const inst = requireInstance();
  const i = inst.idx++;
  let slot = inst.slots[i] as RefSlot | undefined;
  if (!slot) {
    slot = { kind: "ref", ref: { current: initial } };
    inst.slots[i] = slot;
  }
  return slot.ref as { current: T };
}

export function useMemo<T>(factory: () => T, deps: unknown[] | undefined): T {
  const inst = requireInstance();
  const i = inst.idx++;
  const slot = inst.slots[i] as MemoSlot | undefined;
  if (slot && depsEqual(slot.deps, deps)) return slot.value as T;
  const value = factory();
  inst.slots[i] = { kind: "memo", value, deps };
  return value;
}

export function useCallback<T>(cb: T, deps: unknown[] | undefined): T {
  // These are harness stand-ins, not real React hooks; the exhaustive-deps
  // lint rule keys off the `use*` names and does not apply here.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => cb, deps);
}

export function useEffect(
  _effect: () => void | (() => void),
  _deps?: unknown[],
): void {
  // intentionally a no-op — see the scope note in the file header.
}

export const useLayoutEffect = useEffect;

function flush(): void {
  let guard = 0;
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const inst of instances) {
      if (inst.dirty) {
        inst.dirty = false;
        inst.doRender();
        progressed = true;
      }
    }
    if (++guard > 100) throw new Error("act(): updates did not settle");
  }
}

export function act(fn: () => void): void {
  fn();
  flush();
}

export function renderHook<T>(
  render: () => T,
): { result: { current: T }; rerender: () => void } {
  const inst: Instance = {
    slots: [],
    idx: 0,
    rendering: false,
    renderPhaseUpdate: false,
    dirty: false,
    render: render as () => unknown,
    result: undefined,
    doRender: () => {
      /* replaced immediately below */
    },
  };
  const result = { current: undefined as unknown as T };
  inst.doRender = () => {
    let passes = 0;
    do {
      inst.idx = 0;
      inst.renderPhaseUpdate = false;
      const prev = current;
      current = inst;
      inst.rendering = true;
      try {
        inst.result = inst.render();
      } finally {
        inst.rendering = false;
        current = prev;
      }
      if (++passes > 100) {
        throw new Error("renderHook(): render-phase updates did not settle");
      }
    } while (inst.renderPhaseUpdate);
    result.current = inst.result as T;
  };
  instances.push(inst);
  inst.doRender();
  return { result, rerender: inst.doRender };
}

export function resetHarness(): void {
  instances.length = 0;
  current = null;
}
