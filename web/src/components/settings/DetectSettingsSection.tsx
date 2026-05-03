import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { useToast } from "@/components/Toasts";

type DetectSource = "auto" | "llm" | "heuristic";

const STORAGE_KEY = "bridge.detect.source";

const DETECT_OPTIONS: { value: DetectSource; label: string; hint: string }[] = [
  {
    value: "auto",
    label: "Auto",
    hint: "Try LLM first, fall back to heuristic on error or when claude CLI is unavailable. Recommended.",
  },
  {
    value: "llm",
    label: "LLM only",
    hint: "Always call claude -p to detect scope. Falls back to heuristic with low confidence on error.",
  },
  {
    value: "heuristic",
    label: "Heuristic only",
    hint: "Pure local keyword matching. Fastest, deterministic, no API call.",
  },
];

function readStored(): DetectSource {
  if (typeof window === "undefined") return "auto";
  const v = window.localStorage.getItem(STORAGE_KEY);
  if (v === "auto" || v === "llm" || v === "heuristic") return v;
  return "auto";
}

/**
 * Stub of the main-branch DetectSettingsSection. The Go bridge doesn't yet
 * expose `/api/detect/settings`, so the radio cards are wired to localStorage
 * only — a banner makes that explicit. Once the backend lands, swap the
 * persistence layer for `api.detectSettings` / `api.updateDetectSettings`.
 */
export function DetectSettingsSection() {
  const [source, setSource] = useState<DetectSource>("auto");
  const toast = useToast();

  useEffect(() => {
    setSource(readStored());
  }, []);

  const choose = (next: DetectSource) => {
    if (next === source) return;
    setSource(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
      toast.success("Detect source", `Stored locally · ${next}`);
    } catch (e) {
      toast.error("Could not save", (e as Error).message);
    }
  };

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="mb-1 flex items-center gap-2">
        <Sparkles size={14} className="text-primary" />
        <h3 className="text-[13px] sm:text-sm font-semibold">Scope detection</h3>
      </div>
      <p className="mb-3 text-[11px] text-muted-foreground">
        Controls how the bridge picks repo + features for a new task. Detection
        runs once at task-create time and is cached in{" "}
        <span className="font-mono text-foreground">meta.json</span>.
      </p>
      <div className="mb-3 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-warning">
        Backend port pending — settings stored client-side only
        (<span className="font-mono">localStorage:{STORAGE_KEY}</span>).
      </div>

      <div className="grid gap-2">
        {DETECT_OPTIONS.map((opt) => {
          const active = opt.value === source;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => choose(opt.value)}
              aria-pressed={active}
              className={`rounded-md border p-3 text-left transition-colors ${
                active
                  ? "border-primary/40 bg-primary/5"
                  : "border-border hover:border-primary/30 hover:bg-accent/30"
              }`}
            >
              <div className="flex items-center gap-2">
                <span
                  aria-hidden
                  className={`inline-flex h-3.5 w-3.5 rounded-full border ${
                    active
                      ? "border-primary bg-primary"
                      : "border-border bg-transparent"
                  }`}
                />
                <span className="text-sm font-medium text-foreground">
                  {opt.label}
                </span>
                <span className="font-mono text-[10px] text-muted-foreground">
                  {opt.value}
                </span>
              </div>
              <p className="ml-5 mt-1 text-[11px] text-muted-foreground">
                {opt.hint}
              </p>
            </button>
          );
        })}
      </div>
    </section>
  );
}
