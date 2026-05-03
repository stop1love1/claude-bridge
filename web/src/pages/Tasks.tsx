// Tasks page — hosts TaskGrid in a viewport-filling shell. The page no
// longer renders an editorial title block; per main, the global
// HeaderShell + the grid's own sub-toolbar own all the chrome.
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

import { useCallback, useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import TaskGrid, { type TaskGridHandle } from "@/components/TaskGrid";
import NewTaskDialog from "@/components/NewTaskDialog";

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
    <div className="flex h-[calc(100vh-2.75rem)] min-h-0 flex-col">
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
                className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-card px-2 text-xs hover:bg-secondary"
                aria-keyshortcuts="Control+N Meta+N"
                title="New task — Cmd/Ctrl+N"
              >
                + New task
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
