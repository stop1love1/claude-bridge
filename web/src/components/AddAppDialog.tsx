import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Sparkles } from "lucide-react";
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
import { useAddApp, useScanApp } from "@/api/queries";
import { useToast } from "@/components/Toasts";
import { AutoDetectDialog } from "@/components/AutoDetectDialog";

const APP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

interface Props {
  open: boolean;
  onOpenChange: (next: boolean) => void;
}

export interface AddAppDialogHandle {
  open: () => void;
}

/**
 * Modal: declare a new app in `~/.claude/bridge.json`. Validates the
 * name client-side against the same regex the Go bridge uses so we
 * fail fast before the round-trip.
 *
 * Wave-3B port from main: an "Auto-detect from sibling folders" button
 * at the top of the dialog opens the AutoDetectDialog overlay, and a
 * background scan fires after a successful add when description is
 * omitted (so Claude can synthesize one). Imperative `openRef` lets
 * parents (or hotkeys) trigger the dialog without owning the open flag.
 */
export const AddAppDialog = forwardRef<AddAppDialogHandle, Props>(
  function AddAppDialog({ open, onOpenChange }, ref) {
    const [name, setName] = useState("");
    const [path, setPath] = useState("");
    const [description, setDescription] = useState("");
    const [autoDetectOpen, setAutoDetectOpen] = useState(false);
    const nameRef = useRef<HTMLInputElement>(null);
    const toast = useToast();
    const addApp = useAddApp();
    const scanApp = useScanApp();

    useImperativeHandle(ref, () => ({ open: () => onOpenChange(true) }), [
      onOpenChange,
    ]);

    useEffect(() => {
      if (!open) {
        setName("");
        setPath("");
        setDescription("");
        return;
      }
      requestAnimationFrame(() => nameRef.current?.focus());
    }, [open]);

    const trimmedName = name.trim();
    const nameValid = trimmedName.length === 0 || APP_NAME_RE.test(trimmedName);

    const submit = useCallback(async () => {
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
        const needsScan = trimmedDesc.length === 0;
        toast.success(
          `added ${trimmedName}`,
          needsScan ? "scanning with claude…" : undefined,
        );
        onOpenChange(false);
        // Background scan: if the operator skipped the description,
        // ask the Go bridge to read the repo and synthesize one. Any
        // failure stays silent — the heuristic / blank description
        // is a perfectly reasonable fallback and we don't want a
        // scan miss to spam the toast stack.
        if (needsScan) {
          void (async () => {
            try {
              const r = await scanApp.mutateAsync(trimmedName);
              if (r.ok) {
                toast.info(`claude described ${trimmedName}`);
              }
            } catch {
              /* swallow — heuristic stays */
            }
          })();
        }
      } catch (e) {
        toast.error("add failed", (e as Error).message);
      }
    }, [trimmedName, path, description, addApp, scanApp, toast, onOpenChange]);

    return (
      <>
        <Dialog open={open} onOpenChange={onOpenChange}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>add app</DialogTitle>
              <DialogDescription>
                register a sibling project so the coordinator can dispatch
                agents to it. relative paths resolve against the bridge folder.
              </DialogDescription>
            </DialogHeader>

            <div className="-mt-2 mb-1">
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => {
                  onOpenChange(false);
                  setAutoDetectOpen(true);
                }}
                className="gap-1.5 text-muted-foreground hover:text-foreground"
                title="scan parent directories for git repos and pick the ones to register"
              >
                <Sparkles size={12} />
                auto-detect from sibling folders
              </Button>
            </div>

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
                {!nameValid ? (
                  <p className="font-mono text-micro text-status-blocked">
                    invalid characters — use letters, digits, dot, dash,
                    underscore; must start alphanumeric
                  </p>
                ) : (
                  <p className="text-[11px] text-muted-foreground">
                    letters, digits, dots, dashes, underscores. must start
                    alphanumeric.
                  </p>
                )}
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
                <p className="text-[11px] text-muted-foreground">
                  type the path manually — the SPA can&apos;t open a native
                  picker.
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
                <p className="text-[11px] text-muted-foreground">
                  leave blank to let claude synthesize one in the background
                  after add.
                </p>
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
                  disabled={
                    addApp.isPending ||
                    !trimmedName ||
                    !path.trim() ||
                    !APP_NAME_RE.test(trimmedName)
                  }
                >
                  {addApp.isPending ? "adding…" : "add app"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        <AutoDetectDialog
          open={autoDetectOpen}
          onOpenChange={setAutoDetectOpen}
        />
      </>
    );
  },
);
