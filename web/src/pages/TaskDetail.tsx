// /tasks/:id page wrapper. Routing + breadcrumb + URL-state plumbing
// for the detail view: `?sid=<sessionId>` selects which run drives the
// embedded SessionLog, and on narrow viewports `?activeTab=detail|chat`
// remembers which pane the operator was looking at.
//
// The body of the page lives in `<TaskDetailView />` so it can be
// lifted into other surfaces (modal preview, side panel) without
// pulling routing concerns along.

import { useCallback, useEffect } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import TaskDetailView from "@/components/TaskDetailView";

type MobileTab = "detail" | "chat";

export default function TaskDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeSessionId = searchParams.get("sid");
  const rawTab = searchParams.get("activeTab");
  const mobileTab: MobileTab = rawTab === "chat" ? "chat" : "detail";

  const setActiveSessionId = useCallback(
    (sid: string | null) => {
      const params = new URLSearchParams(searchParams);
      if (sid) params.set("sid", sid);
      else params.delete("sid");
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const setMobileTab = useCallback(
    (tab: MobileTab) => {
      const params = new URLSearchParams(searchParams);
      if (tab === "detail") params.delete("activeTab");
      else params.set("activeTab", tab);
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  // Esc → /tasks. Mirrors main lines 315-338: skip the Esc handler
  // when a Radix overlay (Dialog / DropdownMenu / Popover /
  // AlertDialog) is open — Radix handles Esc itself, and running our
  // handler on top would dismiss the overlay AND navigate, losing the
  // operator's place. Also skip when typing inside a text input.
  useEffect(() => {
    const isTextInput = (el: EventTarget | null) => {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
    };
    const overlayOpen = () =>
      typeof document !== "undefined" &&
      !!document.querySelector(
        '[data-radix-popper-content-wrapper], [role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
      );
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isTextInput(e.target) && !overlayOpen()) {
        e.preventDefault();
        navigate("/tasks");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  if (!id) {
    return (
      <div className="px-6 py-10 text-sm text-destructive">
        Missing task id.
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-2.75rem)] flex-col">
      <div className="shrink-0 px-3 py-2 border-b border-border bg-card flex items-center gap-2 text-xs">
        <Link
          to="/tasks"
          className="font-mono text-fg-dim hover:text-foreground"
          title="Back to tasks"
        >
          {id}
        </Link>
        <span className="text-fg-dim">·</span>
        <span className="text-foreground truncate">Task detail</span>
        <span className="ml-auto hidden font-mono text-[10px] text-fg-dim md:inline">
          press <kbd className="rounded border border-border px-1">Esc</kbd> to go back
        </span>
      </div>
      <TaskDetailView
        taskId={id}
        activeSessionId={activeSessionId}
        onActiveSessionIdChange={setActiveSessionId}
        mobileTab={mobileTab}
        onMobileTabChange={setMobileTab}
      />
    </div>
  );
}
