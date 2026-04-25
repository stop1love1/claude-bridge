"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
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

const KIND_STYLE: Record<ToastKind, { icon: React.ComponentType<{ size?: number; className?: string }>; ring: string }> = {
  success: { icon: CheckCircle2, ring: "border-success/40 bg-success/10" },
  error:   { icon: AlertTriangle, ring: "border-destructive/40 bg-destructive/10" },
  info:    { icon: Info, ring: "border-primary/40 bg-primary/10" },
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((kind: ToastKind, message: string) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, kind, message }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4500);
  }, []);

  const dismiss = (id: number) => setToasts((prev) => prev.filter((t) => t.id !== id));

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="fixed top-3 right-3 z-50 flex flex-col gap-2 pointer-events-none">
        {toasts.map((t) => {
          const { icon: Icon, ring } = KIND_STYLE[t.kind];
          return (
            <div
              key={t.id}
              className={`pointer-events-auto flex items-start gap-2 pl-3 pr-2 py-2 rounded-md border ${ring} bg-card text-sm shadow-lg w-80 animate-slide-in`}
            >
              <Icon size={15} className={
                t.kind === "success" ? "text-success mt-0.5 shrink-0" :
                t.kind === "error"   ? "text-destructive mt-0.5 shrink-0" :
                "text-primary mt-0.5 shrink-0"
              } />
              <span className="flex-1 wrap-break-word">{t.message}</span>
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
