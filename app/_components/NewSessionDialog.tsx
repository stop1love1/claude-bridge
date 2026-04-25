"use client";

import { useEffect, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import type { Repo } from "@/lib/client/types";
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
  // Hydrate from localStorage *after* mount so SSR doesn't flash a
  // different default than what the user actually picked last time.
  const [repo, setRepo] = useState(defaultRepo ?? repos[0]?.name ?? "");
  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(REPO_KEY);
    if (stored && repos.some((r) => r.name === stored && r.exists)) {
      setRepo(stored);
    }
  }, [repos]);

  // Keep a sane fallback if the previously-picked repo disappears from
  // BRIDGE.md or the parent dir.
  useEffect(() => {
    if (repo && repos.some((r) => r.name === repo && r.exists)) return;
    const fb = defaultRepo ?? repos[0]?.name ?? "";
    if (fb) setRepo(fb);
  }, [repo, repos, defaultRepo]);

  const groups = useMemo(() => {
    const declared = repos.filter((r) => r.declared !== false && !r.isBridge);
    const bridge   = repos.filter((r) => r.isBridge);
    const other    = repos.filter((r) => r.declared === false);
    return { declared, bridge, other };
  }, [repos]);

  const create = () => {
    if (!repo) return;
    if (typeof window !== "undefined") {
      try { window.localStorage.setItem(REPO_KEY, repo); } catch { /* quota */ }
    }
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
      <Select value={repo} onValueChange={setRepo}>
        <SelectTrigger className="h-7 px-2 text-[11px] gap-1 [&>span]:truncate max-w-[140px]">
          <SelectValue placeholder="Pick a repo" />
        </SelectTrigger>
        <SelectContent>
          {groups.declared.length > 0 && (
            <SelectGroup>
              <SelectLabel>Declared in BRIDGE.md</SelectLabel>
              {renderItems(groups.declared)}
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
      <Button onClick={create} disabled={!repo} size="sm">
        <Plus className="h-3.5 w-3.5" /> New session
      </Button>
    </div>
  );
}
