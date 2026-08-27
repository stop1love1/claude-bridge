"use client";

import { useEffect, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import type { Repo } from "@/libs/client/types";
import { useLocalStorage } from "@/libs/client/useLocalStorage";
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
  const [storedRepo, setStoredRepo] = useLocalStorage<string>(
    REPO_KEY,
    loadStoredRepo,
    "",
    dumpStoredRepo,
  );
  const [override, setOverride] = useState<string | null>(null);

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
