// Pure view fragments for SessionLog. Splits the row renderers out of
// the main component so the index file stays focused on data flow.

import { useState } from "react";
import { ChevronDown, ChevronRight, FileText, Image as ImageIcon, Wrench } from "lucide-react";
import { api } from "@/api/client";
import { cn } from "@/lib/cn";
import {
  asBlocks,
  classify,
  extractAttachments,
  prettyToolName,
  stringifyResult,
  stripSystemTags,
  summarizeInput,
  truncate,
  type ContentBlock,
  type LogEntry,
} from "./helpers";

/** ~3 KB cap on rendered tool input/output. Beyond that → "[truncated]". */
const TOOL_CAP = 3_000;

export function LogRow({
  entry,
  sessionId,
  onRewind,
}: {
  entry: LogEntry;
  sessionId?: string;
  onRewind?: (uuid: string) => void;
}) {
  const kind = classify(entry);
  if (kind === "hidden") return null;
  if (kind === "user") return <UserRow entry={entry} onRewind={onRewind} sessionId={sessionId} />;
  if (kind === "assistant") return <AssistantRow entry={entry} />;
  if (kind === "tool_result") return <ToolResultRow entry={entry} />;
  return null;
}

function UserRow({
  entry,
  sessionId,
  onRewind,
}: {
  entry: LogEntry;
  sessionId?: string;
  onRewind?: (uuid: string) => void;
}) {
  const raw = stringifyResult(entry.message?.content);
  const { stripped, items } = extractAttachments(raw);
  const text = stripSystemTags(stripped);
  if (!text && items.length === 0) return null;
  return (
    <div className="group flex justify-end px-4 py-2">
      <div className="max-w-[78%] rounded-sm border border-accent/30 bg-accent/10 px-3 py-2">
        <div className="mb-1 flex items-center justify-between gap-3">
          <span className="font-mono text-micro uppercase tracking-wideish text-accent">
            user
          </span>
          {entry.uuid && onRewind && (
            <button
              type="button"
              onClick={() => onRewind(entry.uuid as string)}
              className="invisible font-mono text-[10px] uppercase tracking-wideish text-muted hover:text-accent group-hover:visible"
              title="rewind to before this turn"
            >
              rewind
            </button>
          )}
        </div>
        {text && (
          <pre className="whitespace-pre-wrap break-words font-sans text-small text-fg">
            {text}
          </pre>
        )}
        {items.length > 0 && sessionId && (
          <div className="mt-2 flex flex-wrap gap-2">
            {items.map((it, i) => (
              <a
                key={`${it.name}-${i}`}
                href={api.uploads.fileUrl(sessionId, it.name)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-sm border border-border bg-bg px-2 py-1 font-mono text-micro text-muted hover:border-accent/40 hover:text-accent"
              >
                {it.isImage ? <ImageIcon size={11} /> : <FileText size={11} />}
                {it.name}
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AssistantRow({ entry }: { entry: LogEntry }) {
  const blocks = asBlocks(entry.message?.content);
  if (blocks.length === 0) return null;
  return (
    <div className="px-4 py-2">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="font-mono text-micro uppercase tracking-wideish text-muted">
          assistant
        </span>
        {entry.timestamp && (
          <span className="font-mono text-[10px] tabular-nums text-muted-2">
            {new Date(entry.timestamp).toLocaleTimeString()}
          </span>
        )}
      </div>
      <div className="space-y-2">
        {blocks.map((b, i) => (
          <AssistantBlock block={b} key={i} />
        ))}
      </div>
    </div>
  );
}

function AssistantBlock({ block }: { block: ContentBlock }) {
  if (block.type === "text" && block.text) {
    const text = stripSystemTags(block.text);
    if (!text) return null;
    return (
      <pre className="whitespace-pre-wrap break-words font-sans text-small leading-relaxed text-fg">
        {text}
      </pre>
    );
  }
  if (block.type === "thinking" && block.thinking) {
    return (
      <details className="rounded-sm border border-dashed border-border bg-surface/50 px-3 py-2">
        <summary className="cursor-pointer font-mono text-micro uppercase tracking-wideish text-muted-2">
          thinking
        </summary>
        <pre className="mt-2 whitespace-pre-wrap break-words font-sans text-small text-muted">
          {block.thinking}
        </pre>
      </details>
    );
  }
  if (block.type === "tool_use") {
    return <ToolUseBlock block={block} />;
  }
  return null;
}

function ToolUseBlock({ block }: { block: ContentBlock }) {
  const [open, setOpen] = useState(false);
  const name = prettyToolName(block.name ?? "tool");
  const summary = summarizeInput(block.input);
  const json = JSON.stringify(block.input ?? {}, null, 2);
  const truncated = json.length > TOOL_CAP;
  return (
    <div className="rounded-sm border border-border bg-surface-2/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-2"
      >
        {open ? (
          <ChevronDown size={12} className="text-muted-2" />
        ) : (
          <ChevronRight size={12} className="text-muted-2" />
        )}
        <Wrench size={12} className="text-accent" />
        <span className="font-mono text-micro uppercase tracking-wideish text-fg">
          {name}
        </span>
        {summary && (
          <span className="truncate font-mono text-micro text-muted-2">
            {summary}
          </span>
        )}
      </button>
      {open && (
        <pre className="overflow-x-auto border-t border-border bg-bg px-3 py-2 font-mono text-[11px] leading-relaxed text-muted">
          {truncated ? json.slice(0, TOOL_CAP) + "\n\n[truncated]" : json}
        </pre>
      )}
    </div>
  );
}

function ToolResultRow({ entry }: { entry: LogEntry }) {
  const blocks = asBlocks(entry.message?.content);
  const result = blocks.find((b) => b.type === "tool_result");
  if (!result) return null;
  const isError = !!result.is_error;
  const text = stringifyResult(result.content);
  const truncated = text.length > TOOL_CAP;
  const display = truncated ? text.slice(0, TOOL_CAP) + "\n\n[truncated]" : text;
  const [open, setOpen] = useState(false);
  return (
    <div className="px-4 py-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex w-full items-center gap-2 rounded-sm border px-3 py-1.5 text-left hover:bg-surface-2",
          isError
            ? "border-status-blocked/40 bg-status-blocked/5"
            : "border-border bg-surface/40",
        )}
      >
        {open ? (
          <ChevronDown size={12} className="text-muted-2" />
        ) : (
          <ChevronRight size={12} className="text-muted-2" />
        )}
        <span
          className={cn(
            "font-mono text-micro uppercase tracking-wideish",
            isError ? "text-status-blocked" : "text-muted",
          )}
        >
          {isError ? "tool_error" : "tool_result"}
        </span>
        <span className="truncate font-mono text-micro text-muted-2">
          {truncate(text.replace(/\s+/g, " ").trim(), 90)}
        </span>
      </button>
      {open && (
        <pre className="mt-1 overflow-x-auto rounded-sm border border-border bg-bg px-3 py-2 font-mono text-[11px] leading-relaxed text-muted">
          {display}
        </pre>
      )}
    </div>
  );
}
