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
  destructive?: boolean;
  onConfirm?: () => Promise<void>;
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

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
              {}
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
