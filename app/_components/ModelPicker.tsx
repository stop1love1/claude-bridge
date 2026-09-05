"use client";

import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { api } from "@/libs/client/api";
import type { ModelChoice } from "@/libs/client/types";
import { cn } from "@/libs/cn";

/**
 * The model list comes from the Claude CLI itself (`GET /api/models`), so it is
 * fetched lazily — discovery shells out, and most renders never show a picker.
 * Pass `enabled` false until the surface is actually visible.
 */
export function useModelChoices(enabled: boolean): {
  models: ModelChoice[] | null;
  failed: boolean;
} {
  const [models, setModels] = useState<ModelChoice[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!enabled || models !== null || failed) return;
    let cancelled = false;
    void api
      .models()
      .then((r) => {
        if (!cancelled) setModels(r.models);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, models, failed]);

  return { models, failed };
}

export function ModelRow({
  label,
  hint,
  description,
  active,
  onSelect,
}: {
  label: string;
  hint?: string;
  description: string;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={cn(
        "w-full text-left rounded-md px-2.5 py-1.5 flex items-start gap-2.5 transition-colors",
        active ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
      )}
    >
      <div className="flex-1 min-w-0">
        <div className="text-[12.5px] font-medium leading-tight text-foreground">
          {label}
          {hint && <span className="font-normal text-muted-foreground"> ({hint})</span>}
        </div>
        <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
          {description}
        </p>
      </div>
      {active && <Check className="h-3.5 w-3.5 text-foreground/80 shrink-0 mt-0.5" />}
    </button>
  );
}

export function modelRowDescription(m: ModelChoice): string {
  return (
    m.description ??
    (m.source === "seen"
      ? `Run on this machine · ${m.value}`
      : `Passed to the CLI as --model ${m.value}`)
  );
}

/**
 * The list of models plus a leading "no pin" row. `undefined` is the value that
 * means "don't pass --model at all", which is what every dispatch did before
 * pinning existed — so it stays the default everywhere this is used.
 */
export function ModelPicker({
  value,
  onChange,
  enabled = true,
  defaultLabel = "Default",
  defaultHint = "recommended",
  defaultDescription = "Whatever model your Claude CLI is configured to use",
}: {
  value: string | undefined;
  onChange: (next: string | undefined) => void;
  enabled?: boolean;
  defaultLabel?: string;
  defaultHint?: string;
  defaultDescription?: string;
}) {
  const { models, failed } = useModelChoices(enabled);

  return (
    <div>
      <div className="-mx-1.5">
        <ModelRow
          label={defaultLabel}
          hint={defaultHint}
          description={defaultDescription}
          active={!value}
          onSelect={() => onChange(undefined)}
        />
        {(models ?? []).map((m) => (
          <ModelRow
            key={m.value}
            label={m.label}
            description={modelRowDescription(m)}
            active={value === m.value}
            onSelect={() => onChange(m.value)}
          />
        ))}
      </div>
      {(models === null || failed) && (
        <p className="px-1.5 pt-1 text-[11px] leading-snug text-muted-foreground">
          {failed
            ? "Could not read the model list from the Claude CLI — Default still works."
            : "Reading the model list from your Claude CLI…"}
        </p>
      )}
    </div>
  );
}
