"use client";


import type { Dispatch, SetStateAction } from "react";
import type { Repo } from "@/libs/client/types";
import {
  Terminal,
  Copy,
  Check,
  Wrench,
  Search,
  Download,
  MoreVertical,
  RotateCw,
} from "lucide-react";
import { exportSessionMarkdown, downloadFile } from "@/libs/client/exportTask";
import { TokenUsage, type TokenTotals } from "../TokenUsage";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import type { ActiveRun, LogEntry } from "./helpers";

export function SessionLogHeader({
  run,
  repo,
  sessionTitle,
  isResponding,
  sessionTotals,
  openSearch,
  showTools,
  setShowTools,
  visibleEntries,
  copied,
  copySessionId,
  onClearConversation,
}: {
  run: ActiveRun;
  repo: Repo | undefined;
  sessionTitle: string | null;
  isResponding: boolean;
  sessionTotals: TokenTotals;
  openSearch: () => void;
  showTools: boolean;
  setShowTools: Dispatch<SetStateAction<boolean>>;
  visibleEntries: LogEntry[];
  copied: boolean;
  copySessionId: () => void;
  onClearConversation?: () => void;
}) {
  return (
    <header className="px-3 py-2 border-b border-border flex items-center gap-2 text-xs min-w-0">
      <Terminal size={13} className="text-muted-foreground shrink-0" />
      <span className="font-medium whitespace-nowrap shrink-0">{run.role}</span>
      {repo && (
        <span className="text-muted-foreground whitespace-nowrap shrink-0">@ {repo.name}</span>
      )}
      {sessionTitle && (
        <span
          className="text-muted-foreground italic truncate min-w-0"
          title={sessionTitle}
        >
          · {sessionTitle}
        </span>
      )}
      {isResponding && (
        <span className="inline-flex items-center gap-1 text-warning text-[10.5px] whitespace-nowrap shrink-0">
          <span className="relative inline-flex h-1.5 w-1.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-warning opacity-60" />
            <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-warning" />
          </span>
          responding…
        </span>
      )}
      <div className="ml-auto flex items-center gap-1 shrink-0">
        {sessionTotals.turns > 0 && (
          <TokenUsage
            totals={sessionTotals}
            variant="compact"
            title={`This window: ${sessionTotals.turns} assistant turns · in ${sessionTotals.inputTokens.toLocaleString()} · out ${sessionTotals.outputTokens.toLocaleString()} · cache read ${sessionTotals.cacheReadTokens.toLocaleString()}`}
          />
        )}
        {}
        <button
          onClick={() => openSearch()}
          className="inline-flex items-center gap-1 h-7 w-7 md:w-auto md:px-1.5 md:h-6 justify-center rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-accent text-[10px] transition-colors"
          title="Search this conversation (Ctrl/⌘+F)"
          aria-label="Search conversation"
        >
          <Search size={11} />
          <span className="hidden md:inline">Search</span>
        </button>
        {}
        <button
          onClick={() => setShowTools((v) => !v)}
          className={`hidden md:inline-flex items-center gap-1 px-1.5 h-6 rounded-md border text-[10px] transition-colors ${
            showTools
              ? "border-border bg-secondary text-foreground"
              : "border-border text-muted-foreground hover:text-foreground hover:bg-accent"
          }`}
          title="Toggle tool results"
        >
          <Wrench size={10} /> {showTools ? "tools" : "no tools"}
        </button>
        <button
          onClick={() => {
            const md = exportSessionMarkdown(visibleEntries, {
              title: `Session ${run.sessionId.slice(0, 8)}`,
              sessionId: run.sessionId,
              repo: run.repo,
              role: run.role,
            });
            downloadFile(`session-${run.sessionId.slice(0, 8)}.md`, md);
          }}
          className="hidden md:inline-flex items-center gap-1 px-1.5 h-6 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-accent text-[10px]"
          title="Export this conversation as Markdown"
        >
          <Download size={10} /> Export
        </button>
        <button
          onClick={copySessionId}
          className="hidden md:inline-flex items-center gap-1 text-muted-foreground hover:text-foreground font-mono text-[11px]"
          title="Copy session ID"
        >
          {run.sessionId.slice(0, 8)}…
          {copied ? <Check size={11} className="text-success" /> : <Copy size={11} />}
        </button>
        {onClearConversation && (
          <button
            onClick={onClearConversation}
            className="hidden md:inline-flex items-center gap-1 px-1.5 h-6 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-accent text-[10px]"
            title="Spawn a fresh coordinator"
          >
            <RotateCw size={10} /> Clear
          </button>
        )}
        {}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="md:hidden inline-flex items-center justify-center h-7 w-7 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-accent"
              title="More actions"
              aria-label="More actions"
            >
              <MoreVertical size={14} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem onClick={() => setShowTools((v) => !v)}>
              <Wrench size={12} />
              {showTools ? "Hide tool results" : "Show tool results"}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                const md = exportSessionMarkdown(visibleEntries, {
                  title: `Session ${run.sessionId.slice(0, 8)}`,
                  sessionId: run.sessionId,
                  repo: run.repo,
                  role: run.role,
                });
                downloadFile(`session-${run.sessionId.slice(0, 8)}.md`, md);
              }}
            >
              <Download size={12} />
              Export Markdown
            </DropdownMenuItem>
            <DropdownMenuItem onClick={copySessionId}>
              {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
              <span className="font-mono">{run.sessionId.slice(0, 8)}…</span>
            </DropdownMenuItem>
            {onClearConversation && (
              <DropdownMenuItem onClick={onClearConversation}>
                <RotateCw size={12} />
                Clear conversation
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
