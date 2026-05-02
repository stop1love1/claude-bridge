"use client";

import { createContext, useCallback, useContext, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";

export interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Use the danger color for the confirm button (delete / destructive). */
  destructive?: boolean;
  /**
   * Optional async work to run while the dialog is still open. When
   * provided, the action button shows a spinner and both buttons are
   * disabled until the promise resolves (then the dialog closes and
   * the outer `confirm()` resolves `true`) or rejects (then the
   * spinner clears and the dialog stays open so the caller can show
   * a toast and the user can retry or cancel). Without this, the
   * dialog closes on click as before.
   */
  onConfirm?: () => Promise<void>;
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

/**
 * Imperative confirm replacement for `window.confirm`. Returns a promise
 * that resolves true on confirm, false on cancel/dismiss. Render
 * `<ConfirmProvider>` once near the root and call `useConfirm()` from
 * anywhere underneath.
 */
export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used inside <ConfirmProvider>");
  return ctx;
}

interface ActiveConfirm extends ConfirmOptions {
  resolve: (v: boolean) => void;
}

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [active, setActive] = useState<ActiveConfirm | null>(null);
  const [busy, setBusy] = useState(false);
  const resolverRef = useRef<((v: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((opts) => {
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
      setBusy(false);
      setActive({ ...opts, resolve });
    });
  }, []);

  const close = (value: boolean) => {
    resolverRef.current?.(value);
    resolverRef.current = null;
    setActive(null);
    setBusy(false);
  };

  const handleAction = async () => {
    if (!active) return;
    if (!active.onConfirm) {
      close(true);
      return;
    }
    // Async path: keep the dialog open while the caller's work runs.
    // On reject we re-enable the buttons so the user can retry; we
    // intentionally don't close because the caller can't surface the
    // error otherwise.
    setBusy(true);
    try {
      await active.onConfirm();
      close(true);
    } catch {
      setBusy(false);
    }
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AlertDialog
        open={!!active}
        onOpenChange={(open) => {
          if (open) return;
          // While `busy`, ignore Esc / overlay clicks — the in-flight
          // promise still owns the resolution.
          if (busy) return;
          close(false);
        }}
      >
        {active && (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{active.title}</AlertDialogTitle>
              {active.description && (
                <AlertDialogDescription>{active.description}</AlertDialogDescription>
              )}
            </AlertDialogHeader>
            <AlertDialogFooter>
              {/* Radix already focuses Cancel on open via
                  onOpenAutoFocus; the explicit autoFocus is
                  belt-and-suspenders for destructive confirms so an
                  accidental Enter cannot destroy data even if Radix's
                  default ever changes. */}
              <AlertDialogCancel
                autoFocus={active.destructive}
                disabled={busy}
                onClick={() => close(false)}
              >
                {active.cancelLabel ?? "Cancel"}
              </AlertDialogCancel>
              <AlertDialogAction
                variant={active.destructive ? "destructive" : "default"}
                disabled={busy}
                onClick={(e) => {
                  // Always own the close lifecycle ourselves so the
                  // resolver fires `true` on the sync path and stays
                  // pending on the async path. Letting Radix auto-close
                  // here would race `close(false)` ahead of our
                  // `close(true)` on certain renders.
                  e.preventDefault();
                  void handleAction();
                }}
              >
                {busy && <Loader2 size={12} className="animate-spin mr-1.5" />}
                {active.confirmLabel ?? (active.destructive ? "Delete" : "OK")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>
    </ConfirmContext.Provider>
  );
}
