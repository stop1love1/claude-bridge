"use client";

import { ToastProvider } from "./Toasts";
import { ConfirmProvider } from "./ConfirmProvider";
import { TooltipProvider } from "./ui/tooltip";
import { ThemeProvider } from "./ThemeProvider";
import { LoginApprovalDialog } from "./LoginApprovalDialog";
import { ShareApprovalDialog } from "./ShareApprovalDialog";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <TooltipProvider delayDuration={300}>
        <ToastProvider>
          <ConfirmProvider>
            {children}
            {}
            <LoginApprovalDialog />
            {}
            <ShareApprovalDialog />
          </ConfirmProvider>
        </ToastProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
}
