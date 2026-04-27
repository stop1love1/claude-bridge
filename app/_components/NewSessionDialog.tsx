"use client";

import { useEffect, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import type { Repo } from "@/lib/client/types";
import { useLocalStorage } from "@/lib/client/useLocalStorage";
import { Button } from "./ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

const REPO_KEY = "bridge.newSession.repo";
const loadStoredRepo = (raw: string | null): string => raw ?? "";
const dumpStoredRepo = (s: string): string => s;

/**
 * "New session" trigger. One click → fresh chat surface for a brand-new
 * session UUID; the spawn is deferred until the user types their first
 * message in the composer (the message route does create-on-first-send).
 *
 * Kept the file/component name `NewSessionDialog` for import stability;
 * it no longer renders a Dialog modal — the selected repo is the only
 * choice the user needs to make, surfaced as a small dropdown next to
 * the button, with the last pick remembered in localStorage.
 */
export function NewSessionDialog({
  repos,
  defaultRepo,
  onCreate,
  openRef,
}: {
  repos: Repo[];
  defaultRepo?: string;
  onCreate: (args: { repo: string }) => Promise<void> | void;
  openRef?: React.MutableRefObject<(() => void) | null>;
}) {
  // The persisted repo lives in localStorage and is hydrated through
  // `useSyncExternalStore` (no SSR-vs-CSR mismatch, no
  // setState-in-effect). `override` captures the user's *current
  // session* pick before they click Create — once Create fires the
  // override is written through to localStorage too.
  const [storedRepo, setStoredRepo] = useLocalStorage<string>(
    REPO_KEY,
    loadStoredRepo,
    "",
    dumpStoredRepo,
  );
  const [override, setOverride] = useState<string | null>(null);

  // Render-time validity fallback: if the requested pick is gone /
  // doesn't exist anymore, drop back through (defaultRepo → first
  // existing repo). No effect needed, no setState cascade.
  const requested = override ?? storedRepo;
  const repo = useMemo(() => {
    if (requested && repos.some((r) => r.name === requested && r.exists)) {
      return requested;
    }
    if (defaultRepo && repos.some((r) => r.name === defaultRepo && r.exists)) {
      return defaultRepo;
    }
    return repos.find((r) => r.exists)?.name ?? "";
  }, [requested, repos, defaultRepo]);

  const groups = useMemo(() => {
    // `declared === true && !isBridge` are apps registered in
    // sessions/init.md. `isBridge` is the bridge folder itself.
    // `declared === false` are sibling folders the bridge spotted on
    // disk but the user hasn't registered yet.
    const registered = repos.filter((r) => r.declared !== false && !r.isBridge);
    const bridge     = repos.filter((r) => r.isBridge);
    const other      = repos.filter((r) => r.declared === false);
    return { registered, bridge, other };
  }, [repos]);

  const create = () => {
    if (!repo) return;
    setStoredRepo(repo);
    setOverride(null);
    void onCreate({ repo });
  };

  // Allow other parts of the page to trigger creation programmatically
  // (e.g. a keyboard shortcut). Keeps the existing openRef contract.
  useEffect(() => {
    if (!openRef) return;
    openRef.current = create;
    return () => { if (openRef.current === create) openRef.current = null; };
  });

  const renderItems = (list: Repo[]) =>
    list.map((r) => (
      <SelectItem key={r.path} value={r.name} disabled={!r.exists}>
        {r.name}
        {r.isBridge ? " (bridge)" : ""}
        {!r.exists ? " — missing" : ""}
      </SelectItem>
    ));

  return (
    <div className="flex items-center gap-1.5">
      <Select value={repo} onValueChange={setOverride}>
        <SelectTrigger className="flex-1 h-7 px-2 text-[11px] gap-1 [&>span]:truncate min-w-0">
          <SelectValue placeholder="Pick a repo" />
        </SelectTrigger>
        <SelectContent>
          {groups.registered.length > 0 && (
            <SelectGroup>
              <SelectLabel>Registered apps</SelectLabel>
              {renderItems(groups.registered)}
            </SelectGroup>
          )}
          {groups.bridge.length > 0 && (
            <SelectGroup>
              <SelectLabel>Bridge</SelectLabel>
              {renderItems(groups.bridge)}
            </SelectGroup>
          )}
          {groups.other.length > 0 && (
            <SelectGroup>
              <SelectLabel>Other folders in parent</SelectLabel>
              {renderItems(groups.other)}
            </SelectGroup>
          )}
        </SelectContent>
      </Select>
      <Button
        onClick={create}
        disabled={!repo}
        size="iconSm"
        title={repo ? `New session in ${repo}` : "Pick a repo first"}
        aria-label="New session"
      >
        <Plus className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
