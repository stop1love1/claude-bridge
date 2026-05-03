import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

// ---------------------------------------------------------------
// useConfirm() — promise-returning confirm dialog. Replaces
// `window.confirm` across the SPA so we get a styled modal that
// matches the editorial chrome and supports a destructive variant
// (used by delete task / clear runs / etc).
// ---------------------------------------------------------------

interface ConfirmOptions {
  title?: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "default" | "destructive";
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const Ctx = createContext<ConfirmFn | null>(null);

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [opts, setOpts] = useState<ConfirmOptions>({});
  // The currently-pending resolver. We can only have one open
  // dialog at a time — calling confirm() while another is open is
  // unusual and harmless: the previous resolver is left dangling
  // in the assertion below. In practice the bridge UI never queues
  // confirms, so this isn't a real risk.
  const resolverRef = useRef<((v: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((o) => {
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
      setOpts(o);
      setOpen(true);
    });
  }, []);

  const settle = useCallback((value: boolean) => {
    setOpen(false);
    const r = resolverRef.current;
    resolverRef.current = null;
    r?.(value);
  }, []);

  const value = useMemo(() => confirm, [confirm]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <AlertDialog
        open={open}
        onOpenChange={(o) => {
          // Radix calls onOpenChange(false) on Escape / overlay click.
          // Treat that as "cancel" so the caller's promise resolves.
          if (!o && resolverRef.current) settle(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{opts.title ?? "confirm"}</AlertDialogTitle>
            {opts.description && (
              <AlertDialogDescription>{opts.description}</AlertDialogDescription>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => settle(false)}>
              {opts.cancelLabel ?? "cancel"}
            </AlertDialogCancel>
            <AlertDialogAction
              variant={opts.variant ?? "default"}
              onClick={() => settle(true)}
            >
              {opts.confirmLabel ?? "confirm"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Ctx.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useConfirm must be used inside <ConfirmProvider>");
  return ctx;
}
