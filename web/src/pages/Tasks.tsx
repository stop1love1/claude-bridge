// Tasks page — replaces v0.1 Board.tsx. Hosts the editorial header,
// the TaskGrid (filters / sort / view-toggle, DnD, bulk actions) and
// the NewTaskDialog action.
//
// Owns three URL-state and keybinding behaviors that don't belong
// inside the grid component:
//   * `?app=<name>` mirror so the operator-selected app filter
//     survives reloads / link sharing. `__all__` is the absent
//     param; `__auto__` selects tasks with no app set.
//   * Cmd/Ctrl+N opens NewTaskDialog (the dialog itself owns its
//     open-state — we trigger via a hidden button click).
//   * "/" focuses the search input inside TaskGrid (via the imperative
//     `focusSearch` handle exposed on the grid).
//   * Cmd/Ctrl+K is owned by `<CommandPaletteHost />` mounted at the
//     app root — no extra wiring needed here.
//
// The header also surfaces a "running" pulse pill that counts every
// run with status === "running" across all tasks. Mirrors main lines
// 354-362.

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import TaskGrid, { type TaskGridHandle } from "@/components/TaskGrid";
import NewTaskDialog from "@/components/NewTaskDialog";
import { useTasksMeta } from "@/api/queries";

const APP_PARAM = "app";
const APP_ALL = "__all__";

export default function Tasks() {
  const [searchParams, setSearchParams] = useSearchParams();
  const appFilter = searchParams.get(APP_PARAM) ?? APP_ALL;

  const setAppFilter = useCallback(
    (next: string) => {
      const params = new URLSearchParams(searchParams);
      if (next === APP_ALL) params.delete(APP_PARAM);
      else params.set(APP_PARAM, next);
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const gridRef = useRef<TaskGridHandle>(null);

  // The Cmd/Ctrl+N hotkey opens NewTaskDialog by clicking the
  // dialog's default trigger — the dialog owns its open-state and
  // doesn't expose an imperative open(). Hidden trigger keeps the
  // header layout untouched.
  const openTriggerRef = useRef<HTMLButtonElement>(null);

  // Running-pulse pill data. The keyed-map cache the grid uses already
  // refetches every 5s, so reading the same hook here is essentially
  // free.
  const { data } = useTasksMeta();
  const runningCount = useMemo(() => {
    let n = 0;
    for (const t of data?.tasks ?? []) {
      for (const r of t.runs) if (r.status === "running") n += 1;
    }
    return n;
  }, [data]);

  useEffect(() => {
    const isTextInput = (el: EventTarget | null) => {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
    };
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "n") {
        if (isTextInput(e.target)) return;
        e.preventDefault();
        openTriggerRef.current?.click();
        return;
      }
      // "/" focuses search — ignore when typing into another input
      // already (browsers send "/" through to the active field).
      if (!isTextInput(e.target) && e.key === "/") {
        e.preventDefault();
        gridRef.current?.focusSearch();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="mx-auto w-full max-w-[1400px] px-6 py-10">
      <header className="mb-10 flex items-end justify-between gap-6">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="font-mono text-display font-semibold tracking-tightish text-foreground">
              cross-repo console
            </h1>
            {runningCount > 0 && (
              <span
                className="inline-flex items-center gap-1.5 rounded-full bg-status-doing/15 px-2 py-0.5 font-mono text-[11px] font-medium text-status-doing"
                title={`${runningCount} run${runningCount === 1 ? "" : "s"} in flight`}
              >
                <span className="relative inline-flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
                </span>
                {runningCount} live
              </span>
            )}
          </div>
          <p className="mt-2 max-w-xl text-small text-muted-foreground">
            tasks coordinate child claude sessions across the apps registered in{" "}
            <span className="font-mono text-foreground">bridge.json</span>. move cards
            between sections as work progresses; the bridge owns git.
          </p>
        </div>
      </header>

      <TaskGrid
        ref={gridRef}
        appFilter={appFilter}
        onAppFilterChange={setAppFilter}
        newTaskTrigger={
          <NewTaskDialog
            trigger={
              <button
                ref={openTriggerRef}
                type="button"
                className="inline-flex h-8 items-center gap-2 rounded-sm border border-border bg-card px-3 font-mono text-xs hover:bg-secondary"
                aria-keyshortcuts="Control+N Meta+N"
                title="new task — Cmd/Ctrl+N"
              >
                + new task
                <kbd className="hidden font-mono text-[10px] text-fg-dim sm:inline">
                  ⌘N
                </kbd>
              </button>
            }
          />
        }
      />
    </div>
  );
}
