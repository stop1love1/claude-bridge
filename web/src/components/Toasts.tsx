import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AlertCircle, CheckCircle2, Info, X, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/cn";

// ---------------------------------------------------------------
// Toasts: a tiny editorial-styled notification stack. No external
// toast library — react-query mutations and SSE handlers call
// `toast.success(...)` / `toast.error(...)` directly. Stack pops up
// bottom-right and auto-dismisses after 5s; click the X to close
// early.
// ---------------------------------------------------------------

export type ToastVariant = "info" | "success" | "warning" | "error";

interface Toast {
  id: number;
  variant: ToastVariant;
  title?: string;
  description?: string;
}

interface ToastApi {
  show: (t: Omit<Toast, "id">) => number;
  info:    (title: string, description?: string) => number;
  success: (title: string, description?: string) => number;
  warning: (title: string, description?: string) => number;
  error:   (title: string, description?: string) => number;
  dismiss: (id: number) => void;
}

const Ctx = createContext<ToastApi | null>(null);

let counter = 0;

const VARIANT_META: Record<ToastVariant, { icon: typeof Info; tone: string }> = {
  info:    { icon: Info,           tone: "border-border       text-fg" },
  success: { icon: CheckCircle2,   tone: "border-status-done/40    text-status-done" },
  warning: { icon: AlertTriangle,  tone: "border-status-doing/40   text-status-doing" },
  error:   { icon: AlertCircle,    tone: "border-status-blocked/40 text-status-blocked" },
};

export function Toaster({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  // Track timer handles so dismiss() can clear them when a toast is
  // closed early — no leaked setTimeouts on unmount.
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: number) => {
    const t = timers.current.get(id);
    if (t) {
      clearTimeout(t);
      timers.current.delete(id);
    }
    setToasts((prev) => prev.filter((x) => x.id !== id));
  }, []);

  const show = useCallback(
    (t: Omit<Toast, "id">) => {
      const id = ++counter;
      setToasts((prev) => [...prev, { ...t, id }]);
      const handle = setTimeout(() => dismiss(id), 5_000);
      timers.current.set(id, handle);
      return id;
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(() => ({
    show,
    info:    (title, description) => show({ variant: "info",    title, description }),
    success: (title, description) => show({ variant: "success", title, description }),
    warning: (title, description) => show({ variant: "warning", title, description }),
    error:   (title, description) => show({ variant: "error",   title, description }),
    dismiss,
  }), [show, dismiss]);

  // Cleanup any pending timers if the Toaster ever unmounts (e.g.
  // during HMR) so we don't leak handles into the next mount.
  useEffect(() => {
    const timersAtMount = timers.current;
    return () => {
      timersAtMount.forEach((h) => clearTimeout(h));
      timersAtMount.clear();
    };
  }, []);

  return (
    <Ctx.Provider value={api}>
      {children}
      <div
        className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-full max-w-sm flex-col gap-2"
        aria-live="polite"
        aria-atomic="false"
      >
        {toasts.map((t) => {
          const { icon: Icon, tone } = VARIANT_META[t.variant];
          return (
            <div
              key={t.id}
              role={t.variant === "error" ? "alert" : "status"}
              className={cn(
                "pointer-events-auto flex items-start gap-3 rounded-sm border bg-surface p-3 shadow-2xl animate-fade-up",
                tone,
              )}
            >
              <Icon size={14} className="mt-0.5 shrink-0" aria-hidden />
              <div className="min-w-0 flex-1">
                {t.title && (
                  <p className="font-mono text-micro uppercase tracking-wideish">
                    {t.title}
                  </p>
                )}
                {t.description && (
                  <p className="mt-0.5 text-small text-fg">{t.description}</p>
                )}
              </div>
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                className="text-muted hover:text-fg shrink-0"
                aria-label="dismiss"
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useToast must be used inside <Toaster>");
  return ctx;
}
