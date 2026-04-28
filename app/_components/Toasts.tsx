"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { CheckCircle2, AlertTriangle, Info, X } from "lucide-react";

type ToastKind = "success" | "error" | "info";
interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

const ToastContext = createContext<(kind: ToastKind, message: string) => void>(() => {});

export function useToast() {
  return useContext(ToastContext);
}

// Each kind gets a solid LEFT-border accent so the toast itself can stay
// fully opaque (bg-card) — the previous `bg-{kind}/10` overlay made
// toasts look washed-out on translucent / blurred backdrops, especially
// on mobile where the small surface needs maximum contrast.
const KIND_STYLE: Record<ToastKind, { icon: React.ComponentType<{ size?: number; className?: string }>; accent: string }> = {
  success: { icon: CheckCircle2, accent: "border-l-success" },
  error:   { icon: AlertTriangle, accent: "border-l-destructive" },
  info:    { icon: Info, accent: "border-l-primary" },
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  // Track outstanding auto-dismiss timers so we can clear them on
  // unmount (and on manual dismiss) — leaving them queued would fire
  // setState on an unmounted provider during HMR / app-shell teardown.
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const push = useCallback((kind: ToastKind, message: string) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, kind, message }]);
    const handle = setTimeout(() => {
      timersRef.current.delete(id);
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4500);
    timersRef.current.set(id, handle);
  }, []);

  const dismiss = (id: number) => {
    const handle = timersRef.current.get(id);
    if (handle) {
      clearTimeout(handle);
      timersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const handle of timers.values()) clearTimeout(handle);
      timers.clear();
    };
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="fixed top-3 right-3 z-50 flex flex-col gap-2 pointer-events-none max-w-[calc(100vw-1.5rem)]">
        {toasts.map((t) => {
          const { icon: Icon, accent } = KIND_STYLE[t.kind];
          return (
            <div
              key={t.id}
              className={`pointer-events-auto flex items-start gap-2 pl-3 pr-2 py-2 rounded-md border border-border border-l-4 ${accent} bg-card text-foreground text-sm shadow-xl w-80 max-w-full animate-slide-in`}
            >
              <Icon size={15} className={
                t.kind === "success" ? "text-success mt-0.5 shrink-0" :
                t.kind === "error"   ? "text-destructive mt-0.5 shrink-0" :
                "text-primary mt-0.5 shrink-0"
              } />
              <span
                className="flex-1 min-w-0 whitespace-pre-wrap"
                style={{ overflowWrap: "anywhere", wordBreak: "break-word" }}
              >
                {t.message}
              </span>
              <button
                onClick={() => dismiss(t.id)}
                className="text-muted-foreground hover:text-foreground p-0.5 rounded shrink-0"
                aria-label="Dismiss"
              >
                <X size={13} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
