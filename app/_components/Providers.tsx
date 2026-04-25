"use client";

import { ToastProvider } from "./Toasts";
import { ConfirmProvider } from "./ConfirmProvider";
import { TooltipProvider } from "./ui/tooltip";

/**
 * Client-side provider stack. Wraps every page once via the root layout
 * so `useToast` / `useConfirm` / shadcn primitives work anywhere without
 * per-page boilerplate.
 *
 * NOTE: PreToolUse permission popups are no longer rendered as a global
 * modal. Each `SessionLog` mounts its own `<InlinePermissionRequests>`
 * panel so Allow / Deny cards appear contextually inside the agent's
 * chat pane that's actually waiting on permission. If a child agent is
 * spawned while the user isn't watching its session, the hook simply
 * times out (5 min) and fail-opens — the bridge does not interrupt the
 * page the user is actually on.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <TooltipProvider delayDuration={300}>
      <ToastProvider>
        <ConfirmProvider>{children}</ConfirmProvider>
      </ToastProvider>
    </TooltipProvider>
  );
}
