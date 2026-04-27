"use client";

import { ToastProvider } from "./Toasts";
import { ConfirmProvider } from "./ConfirmProvider";
import { TooltipProvider } from "./ui/tooltip";
import { ThemeProvider } from "./ThemeProvider";
import { LoginApprovalDialog } from "./LoginApprovalDialog";

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
    <ThemeProvider>
      <TooltipProvider delayDuration={300}>
        <ToastProvider>
          <ConfirmProvider>
            {children}
            {/* Polls /api/auth/approvals every ~3s and surfaces a
                modal whenever ANOTHER device tries to sign in. Mounted
                here (above ConfirmProvider's children) so it triggers
                regardless of which page the operator is on. The
                component itself returns null for unauthenticated
                callers — the polled endpoint 401s, dialog never opens. */}
            <LoginApprovalDialog />
          </ConfirmProvider>
        </ToastProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
}
