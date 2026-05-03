import { useEffect, useState } from "react";
import { Globe } from "lucide-react";
import {
  useBridgeSettings,
  useUpdateBridgeSettings,
} from "@/api/queries";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/Toasts";

/**
 * Strip everything but origin so saved values match the server's normalisation
 * step — pasting `https://bridge.example.com/some/path?x=1` always saves as
 * `https://bridge.example.com`. Returns the empty string on invalid input so
 * the caller can surface a validation error.
 */
function normalizeOrigin(raw: string): { ok: true; origin: string } | { ok: false; reason: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, origin: "" };
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, reason: "must use http:// or https://" };
  }
  if (u.pathname !== "/" && u.pathname !== "") {
    return { ok: false, reason: "origin only — drop the path" };
  }
  if (u.search || u.hash) {
    return { ok: false, reason: "origin only — drop ?query / #hash" };
  }
  // u.origin already normalises trailing-slash / port edge cases.
  return { ok: true, origin: u.origin };
}

export function PublicUrlSection() {
  const { data, isLoading } = useBridgeSettings();
  const update = useUpdateBridgeSettings();
  const toast = useToast();
  const [draft, setDraft] = useState("");
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (!hydrated && data) {
      setDraft(typeof data.publicUrl === "string" ? data.publicUrl : "");
      setHydrated(true);
    }
  }, [data, hydrated]);

  const current =
    typeof data?.publicUrl === "string" ? (data.publicUrl as string) : "";
  const trimmed = draft.trim();
  const validation = normalizeOrigin(draft);
  const dirty = trimmed !== current;
  const canSave = dirty && (validation.ok || trimmed === "");

  const submit = async () => {
    if (!validation.ok) return;
    try {
      await update.mutateAsync({ ...data, publicUrl: validation.origin });
      toast.success(
        validation.origin ? "Public URL saved" : "Public URL cleared",
      );
    } catch (e) {
      toast.error("Save failed", (e as Error).message);
    }
  };

  const clear = async () => {
    try {
      await update.mutateAsync({ ...data, publicUrl: "" });
      setDraft("");
      toast.info("Public URL cleared");
    } catch (e) {
      toast.error("Clear failed", (e as Error).message);
    }
  };

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="mb-1 flex items-center gap-2">
        <Globe size={14} className="text-primary" />
        <h3 className="text-[13px] sm:text-sm font-semibold">Public URL</h3>
      </div>
      <p className="mb-4 text-[11px] text-muted-foreground">
        The origin the bridge is reachable at after deploy. Used to render
        clickable links in webhook payloads, Telegram pings, magic-link
        emails. Leave blank when running locally.
      </p>

      {isLoading ? (
        <Skeleton className="h-8 w-full rounded-md" />
      ) : (
        <div className="grid gap-2">
          <Label htmlFor="public-url">Public origin</Label>
          <Input
            id="public-url"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="https://bridge.example.com"
            spellCheck={false}
            inputMode="url"
            autoComplete="off"
          />
          {!validation.ok && trimmed !== "" ? (
            <p className="text-[11px] text-destructive">
              {validation.reason}
            </p>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              Origin only — http:// or https://. Path / query / hash get stripped on save.
            </p>
          )}
          <div className="flex items-center gap-2 pt-1">
            <Button
              onClick={() => void submit()}
              disabled={update.isPending || !canSave}
            >
              {update.isPending ? "Saving…" : "Save"}
            </Button>
            {current && (
              <>
                <div className="flex-1" />
                <Button
                  variant="ghost"
                  onClick={() => void clear()}
                  disabled={update.isPending}
                  className="text-fg-dim hover:text-destructive"
                >
                  Clear
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
