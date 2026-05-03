import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useAddApp } from "@/api/queries";
import { useToast } from "@/components/Toasts";

const APP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

interface Props {
  open: boolean;
  onOpenChange: (next: boolean) => void;
}

/**
 * Modal: declare a new app in `~/.claude/bridge.json`. Validates the
 * name client-side against the same regex the Go bridge uses so we
 * fail fast before the round-trip.
 */
export function AddAppDialog({ open, onOpenChange }: Props) {
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [description, setDescription] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const addApp = useAddApp();

  useEffect(() => {
    if (!open) {
      setName("");
      setPath("");
      setDescription("");
      return;
    }
    requestAnimationFrame(() => nameRef.current?.focus());
  }, [open]);

  const submit = async () => {
    const trimmedName = name.trim();
    const trimmedPath = path.trim();
    const trimmedDesc = description.trim();
    if (!trimmedName || !trimmedPath) {
      toast.error("validation", "name and path are required");
      return;
    }
    if (!APP_NAME_RE.test(trimmedName)) {
      toast.error(
        "invalid name",
        "letters, digits, dot, dash, underscore; must start alphanumeric",
      );
      return;
    }
    try {
      await addApp.mutateAsync({
        name: trimmedName,
        path: trimmedPath,
        description: trimmedDesc || undefined,
      });
      toast.success(`added ${trimmedName}`);
      onOpenChange(false);
    } catch (e) {
      toast.error("add failed", (e as Error).message);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>add app</DialogTitle>
          <DialogDescription>
            register a sibling project so the coordinator can dispatch agents
            to it. relative paths resolve against the bridge folder.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="grid gap-3 py-1"
        >
          <div className="grid gap-1.5">
            <Label htmlFor="app-name">name</Label>
            <Input
              ref={nameRef}
              id="app-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="app-web"
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-[11px] text-muted">
              letters, digits, dots, dashes, underscores. must start alphanumeric.
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="app-path">path</Label>
            <Input
              id="app-path"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="../app-web  or  /abs/path/to/app-web"
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-[11px] text-muted">
              type the path manually — the SPA can&apos;t open a native picker.
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="app-desc">description (optional)</Label>
            <Textarea
              id="app-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="frontend Next.js dashboard"
            />
          </div>
          <DialogFooter className="mt-1">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={addApp.isPending}
            >
              cancel
            </Button>
            <Button
              type="submit"
              disabled={addApp.isPending || !name.trim() || !path.trim()}
            >
              {addApp.isPending ? "adding…" : "add app"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
