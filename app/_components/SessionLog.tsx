"use client";

import { memo, startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Repo } from "@/lib/client/types";
import { api } from "@/lib/client/api";
import {
  Terminal, Copy, Check, ArrowDown,
  Wrench, FileText, Brain, ChevronDown, ChevronRight, AlertCircle,
  Undo2, ListTodo, Square, CheckSquare, Asterisk,
  Search, X, ArrowUp, Download,
} from "lucide-react";
import { exportSessionMarkdown, downloadFile } from "@/lib/client/exportTask";
import { TokenUsage, type TokenTotals } from "./TokenUsage";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useToast } from "./Toasts";
import { useConfirm } from "./ConfirmProvider";
import { MessageComposer } from "./MessageComposer";
import { InlinePermissionRequests } from "./InlinePermissionRequests";

type ActiveRun = {
  sessionId: string;
  repoPath: string;
  role: string;
  repo: string;
};

interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  id?: string;
  content?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
}

interface UsageBlock {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface LogEntry {
  type?: string;
  timestamp?: string;
  uuid?: string;
  message?: {
    role?: string;
    id?: string;
    content?: string | ContentBlock[];
    /** Present on assistant turns; carries per-turn token accounting. */
    usage?: UsageBlock;
  };
}

// .jsonl is a stream of every event; most are noise to a chat reader.
const HIDDEN_TYPES = new Set([
  "queue-operation", "attachment", "summary",
  "system-prompt-injection", "command-message",
]);

const MAX_RENDERED = 300;

type Kind = "user" | "assistant" | "tool_result" | "hidden";

function classify(entry: LogEntry): Kind {
  if (HIDDEN_TYPES.has(entry.type ?? "")) return "hidden";
  if (entry.type === "user") {
    const c = entry.message?.content;
    if (Array.isArray(c) && c.some((b) => b?.type === "tool_result")) return "tool_result";
    return "user";
  }
  if (entry.type === "assistant") return "assistant";
  return "hidden";
}

function asBlocks(content: unknown): ContentBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) return content as ContentBlock[];
  return [];
}

// Tags Claude re-emits inside user / tool_result messages that are pure
// internal scaffolding — IDE breadcrumbs, slash-command echoes, system
// reminders. Hide them. Only well-known tags are stripped, never arbitrary
// `<foo>` the user might have actually typed.
const SYSTEM_TAGS = [
  "system-reminder",
  "task-notification",
  "ide_opened_file",
  "ide_selection",
  "command-message",
  "command-name",
  "local-command-stdout",
  "local-command-stderr",
  "command-stdout",
  "command-stderr",
];
const SYSTEM_TAG_RE = new RegExp(
  `<(${SYSTEM_TAGS.join("|")})\\b[^>]*>[\\s\\S]*?<\\/\\1>`,
  "g",
);

function stripSystemTags(text: string): string {
  if (!text || text.indexOf("<") === -1) return text;
  // Run repeatedly to catch nested cases. Cap iterations to avoid infinite
  // loops on weird inputs.
  let prev = text;
  for (let i = 0; i < 4; i++) {
    const next = prev.replace(SYSTEM_TAG_RE, "");
    if (next === prev) break;
    prev = next;
  }
  // Collapse 3+ newlines left behind to a single blank line.
  return prev.replace(/\n{3,}/g, "\n\n").trim();
}

function summarizeInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  // Show the most useful single field for common tools.
  const primary = o.file_path ?? o.path ?? o.command ?? o.pattern ?? o.url ?? o.query ?? o.description;
  if (typeof primary === "string") return primary.length > 90 ? primary.slice(0, 90) + "…" : primary;
  return "";
}

function stringifyResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === "string") return b;
        if (b && typeof b === "object" && "text" in b) return String((b as { text: unknown }).text ?? "");
        return JSON.stringify(b);
      })
      .join("\n");
  }
  return JSON.stringify(content, null, 2);
}

// `mcp__plugin_<plugin>_<server>__<toolname>` → "playwright · browser navigate".
// Built-in tool names (Bash / Read / Edit / etc.) pass through unchanged.
function prettyToolName(raw: string): string {
  if (!raw) return raw;
  if (!raw.startsWith("mcp__plugin_")) return raw;
  const rest = raw.slice("mcp__plugin_".length);
  // rest is `<plugin>_<server>__<toolname>` typically — the first `__`
  // separates the server-prefix part from the actual tool name.
  const sepIdx = rest.indexOf("__");
  if (sepIdx === -1) return rest.replace(/__/g, " · ").replace(/_/g, " ");
  const head = rest.slice(0, sepIdx);
  const tail = rest.slice(sepIdx + 2);
  // head looks like `playwright_playwright` or `context7_context7` —
  // collapse repeats to one label.
  const headParts = head.split("_").filter(Boolean);
  const dedup: string[] = [];
  for (const p of headParts) if (dedup[dedup.length - 1] !== p) dedup.push(p);
  const label = dedup.join(" ");
  const toolPretty = tail.replace(/__/g, " · ").replace(/_/g, " ");
  return label ? `${label} · ${toolPretty}` : toolPretty;
}

// Render assistant text as full GitHub-flavoured markdown: code fences,
// inline code, headings, lists, blockquotes, tables, links, bold/italic,
// strikethrough, task lists. Tailwind classes are scoped per-element so
// the output matches the dark chrome of the rest of the chat.
const MD_COMPONENTS = {
  p: (p: React.HTMLAttributes<HTMLParagraphElement>) => (
    <p className="my-1 wrap-break-word whitespace-pre-wrap" {...p} />
  ),
  h1: (p: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h1 className="text-base font-semibold mt-2 mb-1 text-foreground" {...p} />
  ),
  h2: (p: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h2 className="text-sm font-semibold mt-2 mb-1 text-foreground" {...p} />
  ),
  h3: (p: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h3 className="text-[13px] font-semibold mt-2 mb-1 text-foreground" {...p} />
  ),
  h4: (p: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h4 className="text-xs font-semibold mt-1.5 mb-0.5 text-foreground" {...p} />
  ),
  ul: (p: React.HTMLAttributes<HTMLUListElement>) => (
    <ul className="my-1 pl-4 list-disc space-y-0.5" {...p} />
  ),
  ol: (p: React.OlHTMLAttributes<HTMLOListElement>) => (
    <ol className="my-1 pl-5 list-decimal space-y-0.5" {...p} />
  ),
  li: (p: React.LiHTMLAttributes<HTMLLIElement>) => (
    <li className="wrap-break-word" {...p} />
  ),
  blockquote: (p: React.BlockquoteHTMLAttributes<HTMLQuoteElement>) => (
    <blockquote className="border-l-2 border-border pl-3 my-1 text-muted-foreground italic" {...p} />
  ),
  hr: () => <hr className="my-2 border-border" />,
  a: (p: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a className="text-primary hover:underline" target="_blank" rel="noopener noreferrer" {...p} />
  ),
  strong: (p: React.HTMLAttributes<HTMLElement>) => (
    <strong className="font-semibold text-foreground" {...p} />
  ),
  em: (p: React.HTMLAttributes<HTMLElement>) => (
    <em className="italic" {...p} />
  ),
  del: (p: React.HTMLAttributes<HTMLElement>) => (
    <del className="text-fg-dim" {...p} />
  ),
  table: (p: React.TableHTMLAttributes<HTMLTableElement>) => (
    <div className="my-1.5 overflow-x-auto">
      <table className="text-[11px] border-collapse" {...p} />
    </div>
  ),
  th: (p: React.ThHTMLAttributes<HTMLTableCellElement>) => (
    <th className="border border-border px-2 py-1 bg-secondary text-left font-semibold" {...p} />
  ),
  td: (p: React.TdHTMLAttributes<HTMLTableCellElement>) => (
    <td className="border border-border px-2 py-1 align-top" {...p} />
  ),
  code: (props: React.HTMLAttributes<HTMLElement>) => {
    const { className, children, ...rest } = props;
    // react-markdown v10 dropped the `inline` prop, so we have to
    // distinguish ourselves: fenced code blocks (``` ... ```) come
    // through with a `language-foo` class set by the parser; inline
    // backticks never do. The `pre` wrapper provides block layout, so
    // we just need to style the <code> inside.
    const lang = /language-([\w-]+)/.exec(className ?? "")?.[1];
    if (!lang) {
      return (
        <code
          className="px-1 py-px rounded bg-secondary border border-border text-[11px] font-mono"
          {...rest}
        >
          {children}
        </code>
      );
    }
    return (
      <code className={`font-mono text-[11.5px] ${className ?? ""}`} {...rest}>
        <span className="block text-[9px] uppercase tracking-wider text-fg-dim mb-1 select-none">
          {lang}
        </span>
        {children}
      </code>
    );
  },
  pre: (p: React.HTMLAttributes<HTMLPreElement>) => (
    <pre
      className="my-1.5 rounded bg-background border border-border px-2.5 py-2 overflow-x-auto"
      {...p}
    />
  ),
  // Task list checkboxes from remark-gfm.
  input: (p: React.InputHTMLAttributes<HTMLInputElement>) =>
    p.type === "checkbox"
      ? <input className="mr-1 align-middle" disabled {...p} />
      : <input {...p} />,
};

function MarkdownText({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
      {text}
    </ReactMarkdown>
  );
}

function formatThoughtSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  if (seconds < 1) return "<1s";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds - m * 60);
  return s ? `${m}m ${s}s` : `${m}m`;
}

function ThinkingBlockView({
  text,
  durationSec,
}: {
  text: string;
  durationSec?: number;
}) {
  const [open, setOpen] = useState(false);
  const hasContent = text.trim().length > 0;
  const durLabel = durationSec ? formatThoughtSeconds(durationSec) : "";
  const headLabel = durLabel ? `Thought for ${durLabel}` : "Thought";
  const hint = hasContent
    ? `${text.length.toLocaleString()} chars`
    : "redacted";
  return (
    <div className="my-1">
      <button
        onClick={() => hasContent && setOpen((v) => !v)}
        className={`inline-flex items-center gap-1 text-[10.5px] text-fg-dim italic ${
          hasContent ? "hover:text-foreground cursor-pointer" : "cursor-default"
        }`}
        title={hasContent ? "Toggle chain-of-thought" : "Thinking content is not available"}
      >
        {hasContent
          ? (open ? <ChevronDown size={11} /> : <ChevronRight size={11} />)
          : <span className="inline-block w-[11px]" />}
        <Brain size={11} className="text-info" />
        <span className="font-medium not-italic text-fg-dim">{headLabel}</span>
        <span className="opacity-60">· {hint}</span>
      </button>
      {open && hasContent && (
        <pre className="mt-1 px-2 py-1.5 rounded bg-background border border-border text-[11px] text-muted-foreground whitespace-pre-wrap wrap-break-word">
          {text}
        </pre>
      )}
    </div>
  );
}

function BashToolUseView({ block }: { block: ContentBlock }) {
  const [open, setOpen] = useState(false);
  const input = (block.input ?? {}) as Record<string, unknown>;
  const command = typeof input.command === "string" ? input.command : "";
  const description = typeof input.description === "string" ? input.description : "";
  const oneLine = command.replace(/\s*\n\s*/g, " ").trim();
  const TRUNC = 140;
  const truncated = oneLine.length > TRUNC;
  const preview = truncated ? oneLine.slice(0, TRUNC) + "…" : oneLine;
  const multiline = command.includes("\n");
  const expandable = truncated || multiline;
  return (
    <div className="my-0.5">
      <button
        onClick={() => expandable && setOpen((v) => !v)}
        className={`group/tool w-full flex items-start gap-1.5 px-2 py-1 -mx-2 rounded text-left text-[11px] ${expandable ? "hover:bg-accent/50 cursor-pointer" : "cursor-default"}`}
      >
        {expandable ? (
          open ? <ChevronDown size={10} className="shrink-0 mt-1 opacity-60" /> : <ChevronRight size={10} className="shrink-0 mt-1 opacity-60" />
        ) : <span className="w-2.5 shrink-0" />}
        <span className="flex-1 min-w-0">
          <span className="font-mono text-foreground block truncate">
            <span className="text-fg-dim select-none mr-1">$</span>
            {open ? command : preview}
          </span>
          {description && (
            <span className="block text-[10px] text-fg-dim italic mt-0.5 truncate">
              {description}
            </span>
          )}
        </span>
      </button>
    </div>
  );
}

/**
 * Dedicated renderer for `TodoWrite` tool calls. The model uses this
 * tool to publish its evolving plan; rendering the JSON dump (which the
 * generic ToolUseView would do) buries the signal. Mirroring the
 * Claude Code CLI: list each todo with its status icon, swap to the
 * `activeForm` for whichever item is `in_progress`, strike through
 * completed items.
 */
function TodoWriteView({ block }: { block: ContentBlock }) {
  const input = (block.input ?? {}) as Record<string, unknown>;
  const rawTodos = Array.isArray(input.todos) ? input.todos : [];
  const todos = rawTodos
    .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
    .map((t) => ({
      content: typeof t.content === "string" ? t.content : "",
      activeForm: typeof t.activeForm === "string" ? t.activeForm : "",
      status: typeof t.status === "string" ? t.status : "pending",
    }));
  if (todos.length === 0) return null;
  return (
    <div className="my-1">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-foreground">
        <ListTodo size={11} className="text-info" />
        Update Todos
      </div>
      <ul className="mt-1 space-y-0.5 ml-1">
        {todos.map((t, i) => {
          const inProgress = t.status === "in_progress";
          const done = t.status === "completed";
          // Use the present-continuous "activeForm" for the row that's
          // currently running, the imperative "content" for everyone
          // else — same convention Claude Code itself uses.
          const text = inProgress
            ? (t.activeForm || t.content)
            : t.content;
          const Icon = done ? CheckSquare : inProgress ? Asterisk : Square;
          const iconCls = done
            ? "text-success"
            : inProgress
              ? "text-warning animate-pulse"
              : "text-muted-foreground/60";
          const textCls = done
            ? "text-muted-foreground line-through"
            : inProgress
              ? "text-foreground font-medium"
              : "text-muted-foreground";
          return (
            <li key={i} className="flex items-start gap-1.5 text-[11px] leading-snug">
              <Icon size={11} className={`mt-0.5 shrink-0 ${iconCls}`} />
              <span className={`wrap-break-word ${textCls}`}>{text}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ToolUseView({ block }: { block: ContentBlock }) {
  const [open, setOpen] = useState(false);
  const rawName = block.name ?? "tool";
  if (rawName === "Bash") return <BashToolUseView block={block} />;
  if (rawName === "TodoWrite") return <TodoWriteView block={block} />;
  const displayName = prettyToolName(rawName);
  const summary = summarizeInput(block.input);
  return (
    <div className="my-0.5">
      <button
        onClick={() => setOpen((v) => !v)}
        className="group/tool w-full flex items-center gap-1.5 px-2 py-1 -mx-2 rounded text-left hover:bg-accent/50 text-[11px] text-muted-foreground"
      >
        {open ? <ChevronDown size={10} className="shrink-0 opacity-60" /> : <ChevronRight size={10} className="shrink-0 opacity-60" />}
        <Wrench size={10} className="text-info shrink-0" />
        <span className="font-mono font-medium text-foreground shrink-0">{displayName}</span>
        {summary && <span className="font-mono truncate opacity-80">{summary}</span>}
      </button>
      {open && (
        <pre className="ml-5 mt-1 px-2 py-1 rounded bg-muted/40 text-[11px] text-muted-foreground whitespace-pre-wrap wrap-break-word font-mono">
          {JSON.stringify(block.input ?? {}, null, 2)}
        </pre>
      )}
    </div>
  );
}

// Pull image references out of a tool_result text body. Matches:
//   [<alt>](relative/path.png)   ← markdown image / link
//   relative/path.png            ← bare path on its own line
const IMG_MD_RE = /\[[^\]]*\]\(([^)]+\.(?:png|jpe?g|gif|webp|svg|bmp|avif))\)/gi;
const IMG_LINE_RE = /^([^\s<>][^\n]*\.(?:png|jpe?g|gif|webp|svg|bmp|avif))\s*$/gim;

function extractImagePaths(text: string): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  IMG_MD_RE.lastIndex = 0;
  while ((m = IMG_MD_RE.exec(text)) !== null) out.add(m[1].trim());
  IMG_LINE_RE.lastIndex = 0;
  while ((m = IMG_LINE_RE.exec(text)) !== null) out.add(m[1].trim());
  return [...out].filter((p) => !/^https?:\/\//i.test(p));
}

function ImageRefLink({ path, repo }: { path: string; repo?: string }) {
  const [open, setOpen] = useState(false);
  const [errored, setErrored] = useState(false);
  const name = path.split(/[\\/]/).pop() ?? path;
  const url = repo
    ? `/api/repos/${encodeURIComponent(repo)}/raw?path=${encodeURIComponent(path)}`
    : null;
  return (
    <div className="ml-5 my-1">
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline font-mono"
        title={url ? "Toggle preview" : "Image referenced by tool"}
      >
        {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        <FileText size={10} />
        {name}
      </button>
      {open && (
        url && !errored ? (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="block mt-1 max-w-md"
            title="Open full size in a new tab"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={url}
              alt={name}
              onError={() => setErrored(true)}
              className="max-h-72 max-w-full rounded-md border border-border bg-background object-contain hover:border-primary transition-colors"
            />
            <div className="mt-1 text-[10px] text-muted-foreground font-mono break-all">
              {path}
            </div>
          </a>
        ) : (
          <pre className="mt-1 px-2 py-1 rounded bg-muted/40 text-[10.5px] text-muted-foreground font-mono wrap-break-word whitespace-pre-wrap">
            {path}
            {errored && (
              <span className="block mt-1 text-destructive/80">
                Could not load preview (file may be outside the repo or unsupported).
              </span>
            )}
          </pre>
        )
      )}
    </div>
  );
}

function ToolResultView({ block, suppress, repo }: { block: ContentBlock; suppress?: boolean; repo?: string }) {
  const [open, setOpen] = useState(false);
  if (suppress) return null;
  const rawText = stringifyResult(block.content);
  const text = stripSystemTags(rawText);
  const images = extractImagePaths(text);
  // If the entire result is just system-tag scaffolding, hide the row.
  if (!text && images.length === 0) return null;
  const lines = text.split("\n");
  const preview = lines.slice(0, 2).join("\n");
  const hasMore = lines.length > 2 || text.length > 200;
  const Icon = block.is_error ? AlertCircle : FileText;
  const iconCls = block.is_error ? "text-destructive" : "text-muted-foreground/70";
  return (
    <div className="my-0.5">
      {text && (
        <div className="ml-5">
          <button
            onClick={() => hasMore && setOpen((v) => !v)}
            className={`w-full flex items-start gap-1.5 px-2 py-1 -mx-2 rounded text-left ${hasMore ? "hover:bg-accent/50 cursor-pointer" : "cursor-default"}`}
          >
            {hasMore ? (
              open ? <ChevronDown size={10} className="shrink-0 mt-1 opacity-60" /> : <ChevronRight size={10} className="shrink-0 mt-1 opacity-60" />
            ) : <span className="w-2.5 shrink-0" />}
            <Icon size={10} className={`${iconCls} shrink-0 mt-1`} />
            <pre className="text-[11px] text-muted-foreground whitespace-pre-wrap wrap-break-word font-mono flex-1 min-w-0 leading-snug">
              {open ? text : preview}
              {!open && hasMore && <span className="opacity-60"> …</span>}
            </pre>
          </button>
        </div>
      )}
      {images.map((p, i) => (
        <ImageRefLink key={i} path={p} repo={repo} />
      ))}
    </div>
  );
}

// Filler verbs we cycle through while the model is "thinking" (no tool
// running) — Claude Code's CLI uses a similar pool to keep the spinner
// from feeling stuck. Picked deliberately upbeat / non-corporate.
const THINKING_VERBS = [
  "Thinking", "Wrangling", "Pondering", "Brewing", "Cooking",
  "Crunching", "Plotting", "Spinning", "Untangling", "Mulling",
];

/**
 * Status row above the composer. Mirrors the bottom-line indicator
 * the Claude Code CLI puts in its terminal screen — "Thinking…",
 * "Wrangling…", "Running: <bash description>". When `kind: "idle"`
 * the row collapses (returns null) so the composer doesn't flicker.
 */
function ActivityRow({
  activity,
}: {
  activity: { kind: "thinking" | "running" | "idle"; label?: string };
}) {
  const [verbIdx, setVerbIdx] = useState(0);
  // Rotate the filler verb every 2.4s while in thinking state. We don't
  // rotate during "running" — the task description is the actual signal.
  useEffect(() => {
    if (activity.kind !== "thinking") return;
    const t = setInterval(() => {
      setVerbIdx((i) => (i + 1) % THINKING_VERBS.length);
    }, 2400);
    return () => clearInterval(t);
  }, [activity.kind]);

  if (activity.kind === "idle") return null;
  const isThinking = activity.kind === "thinking";
  const verb = isThinking ? THINKING_VERBS[verbIdx] : (activity.label || "task");
  const icon = isThinking ? (
    // gray dot, subtle pulse
    <span
      className="inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground/70 animate-pulse"
      aria-hidden="true"
    />
  ) : (
    // amber asterisk for an active tool / Bash run
    <Asterisk size={11} className="text-warning animate-pulse" aria-hidden="true" />
  );
  return (
    <div className="px-3 py-1.5 border-t border-border bg-card/60 flex items-center gap-1.5 text-[11px] text-muted-foreground">
      {icon}
      <span className={isThinking ? "italic" : "font-medium text-foreground"}>
        {verb}…
      </span>
    </div>
  );
}

/**
 * Live-streaming assistant row. Mirrors the visual weight of a normal
 * assistant TextBlockView but appends a blinking caret so the reader
 * can tell at a glance that text is still being typed in. Markdown is
 * applied to the partial buffer too — most replies are markdown, and
 * react-markdown handles unterminated fences / links gracefully.
 */
function StreamingAssistantRow({ text }: { text: string }) {
  return (
    <div className="my-2 space-y-1">
      <div className="leading-relaxed">
        <MarkdownText text={text} />
        <span
          className="inline-block w-1.5 h-3 ml-0.5 align-text-bottom bg-foreground/70 animate-pulse"
          aria-hidden="true"
        />
      </div>
    </div>
  );
}

function TextBlockView({ text, role }: { text: string; role: "user" | "assistant" }) {
  if (!text) return null;
  if (role === "user") {
    return <div className="whitespace-pre-wrap wrap-break-word">{text}</div>;
  }
  return (
    <div className="leading-relaxed">
      <MarkdownText text={text} />
    </div>
  );
}

const IMG_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;

interface ParsedAttachment {
  rawPath: string;     // absolute path on disk, as written into the .jsonl
  name: string;        // basename
  size?: number;
  isImage: boolean;
}

/**
 * Pull attachments out of a user message we sent. The composer prefixes
 * them with `Attached file: \`<abs path>\` (<name>, <bytes> bytes) — …`,
 * so we can recover them by line-matching that exact shape and strip
 * those lines from the display text.
 */
function extractAttachments(text: string): { stripped: string; items: ParsedAttachment[] } {
  const items: ParsedAttachment[] = [];
  const lines = text.split("\n");
  const kept: string[] = [];
  const re = /^Attached file:\s+`([^`]+)`\s*(?:\(([^)]+)\))?/;
  for (const line of lines) {
    const m = line.match(re);
    if (!m) {
      kept.push(line);
      continue;
    }
    const rawPath = m[1];
    const meta = m[2] ?? "";
    const sizeM = meta.match(/(\d+)\s*bytes?/i);
    const nameM = meta.split(",")[0]?.trim();
    const fallback = rawPath.split(/[\\/]/).pop() ?? rawPath;
    items.push({
      rawPath,
      name: nameM || fallback,
      size: sizeM ? Number(sizeM[1]) : undefined,
      isImage: IMG_EXT.test(rawPath),
    });
  }
  // Trim trailing blank lines left behind by stripped attachment block.
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
  while (kept.length && !kept[0].trim()) kept.shift();
  return { stripped: kept.join("\n"), items };
}

function AttachmentChip({
  att,
  sessionId,
}: {
  att: ParsedAttachment;
  sessionId: string;
}) {
  const url = `/api/uploads/${sessionId}/${encodeURIComponent(att.name)}`;
  if (att.isImage) {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer" className="block">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt={att.name}
          className="max-h-64 max-w-full rounded-md border border-border bg-background object-contain"
        />
        <div className="mt-1 text-[10px] text-muted-foreground font-mono truncate">
          {att.name}
          {att.size != null && (
            <span className="ml-1.5">{(att.size / 1024).toFixed(1)} KB</span>
          )}
        </div>
      </a>
    );
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-border bg-background hover:bg-accent text-[11px]"
    >
      <FileText size={11} className="text-muted-foreground" />
      <span className="font-mono truncate max-w-[180px]">{att.name}</span>
      {att.size != null && (
        <span className="text-muted-foreground tabular-nums">
          {(att.size / 1024).toFixed(1)}KB
        </span>
      )}
    </a>
  );
}

/**
 * One row per .jsonl entry, but no per-entry "card" anymore — we let
 * the per-block components carry their own visual weight. User typed
 * messages get a right-aligned bubble (chat-style), assistant text
 * flows left as plain markdown, tool calls / results render compact
 * and dim. Keeps the chat skim-able.
 */
const LogRow = memo(function LogRow({
  entry,
  sessionId,
  onRewindToHere,
  toolNames,
  repo,
  prevTimestamp,
}: {
  entry: LogEntry;
  sessionId: string;
  onRewindToHere?: (uuid: string) => void;
  toolNames?: Map<string, string>;
  repo?: string;
  prevTimestamp?: string;
}) {
  const kind = classify(entry);
  if (kind === "hidden") return null;
  const blocks = asBlocks(entry.message?.content);
  const canRewind = kind === "user" && !!entry.uuid && !!onRewindToHere;

  // Right-aligned user bubble, ChatGPT/Claude style. Attachments are
  // pulled out and rendered as image previews / file chips above the text.
  if (kind === "user") {
    const raw = blocks
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text!)
      .join("\n\n");
    const { stripped, items: attachments } = extractAttachments(raw);
    // Strip system-reminder / task-notification / IDE breadcrumbs etc.
    // before checking emptiness — if all that's left is scaffolding,
    // suppress the row entirely.
    const cleaned = stripSystemTags(stripped);
    if (!cleaned.trim() && attachments.length === 0) return null;
    return (
      <div className="group flex justify-end gap-1.5 my-3" data-user-uuid={entry.uuid ?? ""}>
        {canRewind && (
          <button
            onClick={() => onRewindToHere!(entry.uuid!)}
            className="self-end inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-muted-foreground/70 hover:text-warning"
            title="Rewind: drop every later entry"
          >
            <Undo2 size={10} /> rewind
          </button>
        )}
        <div className="max-w-[80%] flex flex-col items-end gap-1.5">
          {attachments.length > 0 && (
            <div className="flex flex-col items-end gap-1.5">
              {attachments.map((a, i) => (
                <AttachmentChip key={i} att={a} sessionId={sessionId} />
              ))}
            </div>
          )}
          {cleaned.trim() && (
            <div className="rounded-2xl rounded-br-md bg-secondary px-3 py-2 text-[12.5px] whitespace-pre-wrap wrap-break-word">
              {cleaned}
            </div>
          )}
        </div>
      </div>
    );
  }

  // Tool result lives on a "user-typed" entry per Anthropic schema, but
  // we render it as a result line under the assistant's prior tool_use.
  // F.2: TodoWrite confirmations ("Todos have been modified successfully…")
  // are pure ceremony — suppress them. The tool_use block carries the
  // actual list, which renders fine.
  if (kind === "tool_result") {
    const rendered = blocks
      .map((b, i) => {
        if (b.type !== "tool_result") return null;
        const tuid = b.tool_use_id ?? "";
        const name = tuid && toolNames ? toolNames.get(tuid) : undefined;
        const suppress = name === "TodoWrite";
        // Stable key: tool_use_id pairs each result to its unique
        // tool_use call. Falling back to index is fine when the model
        // emitted a result without an id (rare malformed payloads).
        const key = tuid || `idx-${i}`;
        return <ToolResultView key={key} block={b} suppress={suppress} repo={repo} />;
      })
      .filter(Boolean);
    if (rendered.length === 0) return null;
    return <div className="my-0.5">{rendered}</div>;
  }

  // Assistant: render every block flush-left, no card. Multiple blocks
  // (text + tool_use chain) hang together visually because they share
  // the entry-level vertical margin.
  // F.6: merge adjacent text blocks into a single MarkdownText render so
  // a paragraph that the model emitted as `text, text, text` renders as
  // one flowing block (instead of three separately-margined rows).
  type Renderable =
    | { kind: "text"; text: string }
    | { kind: "thinking"; text: string }
    | { kind: "tool_use"; block: ContentBlock };
  const merged: Renderable[] = [];
  for (const b of blocks) {
    if (b.type === "text" && typeof b.text === "string") {
      const last = merged[merged.length - 1];
      if (last && last.kind === "text") {
        last.text += "\n\n" + b.text;
      } else {
        merged.push({ kind: "text", text: b.text });
      }
    } else if (b.type === "thinking" && typeof b.thinking === "string") {
      merged.push({ kind: "thinking", text: b.thinking });
    } else if (b.type === "tool_use") {
      merged.push({ kind: "tool_use", block: b });
    }
  }
  // Approximate the model's thinking duration as the wall-clock gap
  // between the prior entry (typically the user message that triggered
  // this turn) and this assistant entry. It rolls in any tool wait
  // time too, but for a single-turn thought it's the closest signal we
  // have without per-token stream timing.
  const thoughtDurationSec = (() => {
    if (!prevTimestamp || !entry.timestamp) return undefined;
    const a = Date.parse(prevTimestamp);
    const b = Date.parse(entry.timestamp);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return undefined;
    return (b - a) / 1000;
  })();
  return (
    <div className="my-2 space-y-1">
      {merged.map((m, i) => {
        if (m.kind === "text") return <TextBlockView key={i} text={m.text} role="assistant" />;
        if (m.kind === "thinking") return <ThinkingBlockView key={i} text={m.text} durationSec={thoughtDurationSec} />;
        return <ToolUseView key={i} block={m.block} />;
      })}
    </div>
  );
}, (prev, next) => {
  // Re-render only when meaningful inputs change. `toolNames` is rebuilt
  // on every entries-tick, but it's only consulted by tool_result rows;
  // for everything else its identity flip is noise. Compare by entry
  // identity + sessionId + the tool-names lookup result for any
  // tool_use_id this entry references.
  if (prev.entry !== next.entry) return false;
  if (prev.sessionId !== next.sessionId) return false;
  if (prev.onRewindToHere !== next.onRewindToHere) return false;
  if (prev.repo !== next.repo) return false;
  if (prev.prevTimestamp !== next.prevTimestamp) return false;
  // Pull tool_use_ids that this entry's tool_result blocks point at and
  // compare their resolved names. If the entry doesn't have any, the
  // toolNames prop is irrelevant.
  if (classify(next.entry) === "tool_result") {
    const blocks = asBlocks(next.entry.message?.content);
    for (const b of blocks) {
      if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
        const a = prev.toolNames?.get(b.tool_use_id);
        const c = next.toolNames?.get(b.tool_use_id);
        if (a !== c) return false;
      }
    }
  }
  return true;
});

function SessionLogInner({
  run,
  repos,
  taskId,
  onClearConversation,
}: {
  run: ActiveRun | null;
  repos: Repo[];
  taskId?: string;
  onClearConversation?: () => void;
}) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [trimmed, setTrimmed] = useState(0);
  const [autoScroll, setAutoScroll] = useState(true);
  const [copied, setCopied] = useState(false);
  const [showTools, setShowTools] = useState(true);
  const [lastTs, setLastTs] = useState<number>(0);
  const [pinnedUserUuid, setPinnedUserUuid] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // Live token-streaming buffers, keyed by assistant message id (msg_…)
  // emitted by claude's stream_event/message_start. We append on every
  // content_block_delta/text_delta and drop the entry once the canonical
  // assistant line lands in `entries` with the matching message.id.
  const [partials, setPartials] = useState<Record<string, string>>({});
  // Server-reported child-process state. null until the first `alive`
  // SSE event arrives — until then we fall back to the lastTs heuristic
  // so the UI doesn't lose its responding indicator on a stream blip.
  const [aliveSse, setAliveSse] = useState<boolean | null>(null);
  // "Thinking… / Running <bash>…" indicator, fed by the claude
  // stream-json `system/status` and `system/task_started` events.
  // Mirrors the bottom line of the Claude Code CLI's terminal screen.
  const [activity, setActivity] = useState<{
    kind: "thinking" | "running" | "idle";
    label?: string;
  }>({ kind: "idle" });
  const offsetRef = useRef(0);
  // Byte offset of the FIRST loaded line. null = nothing loaded yet,
  // 0 = we've reached the start of the file. Anything > 0 means we
  // have older history we could fetch.
  const firstOffsetRef = useRef<number | null>(null);
  // Byte offsets parallel to `entries`, so cap-trimming on forward
  // growth can keep `firstOffsetRef` in sync.
  const entryOffsetsRef = useRef<number[]>([]);
  // How many of the FRONT entries arrived via backward paging. The
  // forward-tick cap MUST NOT trim these — that would yo-yo the user
  // back to the bottom every second.
  const loadedOlderCountRef = useRef(0);
  const inFlightOlderRef = useRef(false);
  // Scroll-restoration handoff: the backward fetch sets prevHeight here,
  // and the layout effect after re-render restores scrollTop.
  const pendingScrollRestoreRef = useRef<{ prevHeight: number; prevTop: number } | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const toast = useToast();
  const confirm = useConfirm();

  useEffect(() => {
    offsetRef.current = 0;
    firstOffsetRef.current = null;
    entryOffsetsRef.current = [];
    loadedOlderCountRef.current = 0;
    inFlightOlderRef.current = false;
    pendingScrollRestoreRef.current = null;
    setEntries([]);
    setTrimmed(0);
    setAutoScroll(true);
    setLastTs(0);
    setPinnedUserUuid(null);
    setLoadingOlder(false);
    setPartials({});
    setAliveSse(null);
    setActivity({ kind: "idle" });
    if (!run) return;

    let stopped = false;
    let es: EventSource | null = null;
    // SSE-driven timers we own and must clear on unmount / re-run. The
    // `alive: false` handler schedules a delayed sweep of the live
    // streaming buffer; without storing the handle, an unmount or a
    // visibility flip would let the callback fire on a stale closure
    // and clobber `partials` of the next mount (CRIT-6).
    let aliveSweepTimer: ReturnType<typeof setTimeout> | null = null;

    /**
     * Apply a `{ lines, offset, lineOffsets }` payload — same merge
     * shape as the REST `/tail` response, used both by the SSE handler
     * and the visibility-flip catch-up REST call.
     */
    const applyTail = (payload: {
      lines: unknown[];
      offset: number;
      lineOffsets: number[] | undefined;
    }) => {
      offsetRef.current = payload.offset;
      if (!payload.lines.length) return;
      const lines = payload.lines as LogEntry[];
      const newest = lines[lines.length - 1]?.timestamp;
      if (newest) setLastTs(new Date(newest).getTime());
      const newLineOffsets = Array.isArray(payload.lineOffsets) ? payload.lineOffsets : [];
      // Canonical assistant line → drop the matching live-streaming
      // buffer so the rendered ghost row collapses into the real one.
      // Also drop sentinel `live:*` ids whenever any assistant line
      // lands; they were only there because the parser hadn't seen
      // message_start yet.
      const arrivedAssistant = lines.some((l) => l?.type === "assistant");
      if (arrivedAssistant) {
        setPartials((prev) => {
          const next = { ...prev };
          for (const l of lines) {
            const id = l?.message?.id;
            if (typeof id === "string" && next[id] !== undefined) {
              delete next[id];
            }
          }
          for (const k of Object.keys(next)) {
            if (k.startsWith("live:")) delete next[k];
          }
          return next;
        });
      }
      startTransition(() => {
        setEntries((prev) => {
          const merged = [...prev, ...lines];
          const mergedOffsets = [
            ...entryOffsetsRef.current,
            ...newLineOffsets,
          ];
          // Cap accounting: never trim the FRONT entries that came in
          // via a backward load. Trim only the post-prefix tail-window
          // beyond MAX_RENDERED.
          const protectedFront = loadedOlderCountRef.current;
          const trimWindow = merged.length - protectedFront;
          if (trimWindow <= MAX_RENDERED) {
            entryOffsetsRef.current = mergedOffsets;
            if (firstOffsetRef.current === null) {
              firstOffsetRef.current = mergedOffsets[0] ?? 0;
            }
            return merged;
          }
          const drop = trimWindow - MAX_RENDERED;
          setTrimmed((t) => t + drop);
          const keptOffsets = [
            ...mergedOffsets.slice(0, protectedFront),
            ...mergedOffsets.slice(protectedFront + drop),
          ];
          entryOffsetsRef.current = keptOffsets;
          if (firstOffsetRef.current === null) {
            firstOffsetRef.current = keptOffsets[0] ?? 0;
          }
          return [
            ...merged.slice(0, protectedFront),
            ...merged.slice(protectedFront + drop),
          ];
        });
      });
    };

    /**
     * Open an SSE connection. Reopens automatically on tab-visible
     * after a hidden close. We pass `since=offsetRef.current` so a
     * reconnect doesn't replay history we already have. EventSource's
     * built-in auto-reconnect handles transient network drops.
     */
    const openStream = () => {
      if (stopped || es) return;
      const url = `/api/sessions/${encodeURIComponent(run.sessionId)}/tail/stream?repo=${encodeURIComponent(run.repoPath)}&since=${offsetRef.current}`;
      try {
        es = new EventSource(url);
      } catch {
        return;
      }
      es.addEventListener("tail", (ev) => {
        if (stopped) return;
        try {
          const payload = JSON.parse((ev as MessageEvent).data);
          applyTail(payload);
        } catch { /* malformed — ignore */ }
      });
      // Token-by-token streaming from claude's stream-json output. Each
      // payload is a small text fragment; we accumulate them by message
      // id so the ghost assistant row keeps growing until the canonical
      // .jsonl line lands and prunes the buffer.
      es.addEventListener("partial", (ev) => {
        if (stopped) return;
        try {
          const p = JSON.parse((ev as MessageEvent).data) as {
            messageId: string;
            index: number;
            text: string;
          };
          if (!p?.text) return;
          setPartials((prev) => ({
            ...prev,
            [p.messageId]: (prev[p.messageId] ?? "") + p.text,
          }));
          // Treat partial deltas as activity for the responding-indicator
          // fallback so the indicator stays warm on long replies.
          setLastTs(Date.now());
        } catch { /* malformed — ignore */ }
      });
      // Process lifecycle. Drives the Stop button — without this the
      // button would vanish during long tool calls, since the previous
      // 4-second-since-last-tail heuristic couldn't tell "subprocess
      // is busy thinking" apart from "subprocess died".
      es.addEventListener("alive", (ev) => {
        if (stopped) return;
        try {
          const { alive } = JSON.parse((ev as MessageEvent).data) as { alive: boolean };
          setAliveSse(alive);
          // When the process exits without ever writing a canonical
          // assistant line (rare: crash mid-turn / killed by Stop), the
          // ghost row would otherwise sit forever. Sweep partials a
          // couple of seconds after exit.
          if (!alive) {
            setActivity({ kind: "idle" });
            if (aliveSweepTimer) clearTimeout(aliveSweepTimer);
            aliveSweepTimer = setTimeout(() => {
              aliveSweepTimer = null;
              if (stopped) return;
              setPartials((prev) => (Object.keys(prev).length ? {} : prev));
            }, 2000);
          }
        } catch { /* malformed — ignore */ }
      });
      // Activity indicator — claude's `system/status` and
      // `system/task_started` events arrive here so the UI can show
      // "Thinking…" / "Running: <description>" between the chat log
      // and the composer.
      es.addEventListener("status", (ev) => {
        if (stopped) return;
        try {
          const s = JSON.parse((ev as MessageEvent).data) as {
            kind: "thinking" | "running" | "idle";
            label?: string;
          };
          if (s && (s.kind === "thinking" || s.kind === "running" || s.kind === "idle")) {
            setActivity({ kind: s.kind, label: s.label });
          }
        } catch { /* malformed — ignore */ }
      });
      // EventSource auto-reconnects on transient errors; we just stay
      // quiet and let the browser handle it. Persistent failure (server
      // unreachable) will keep firing `error` but doesn't need our help.
    };

    const closeStream = () => {
      try { es?.close(); } catch { /* ignore */ }
      es = null;
    };

    // Tab hidden → drop the connection so an idle session tab doesn't
    // hold an open HTTP/1.1 SSE slot (browsers cap to 6/origin). On
    // re-show, reopen and (one-shot) REST-tail any bytes we missed
    // while disconnected — SSE only pushes events that fired during
    // the connection.
    const onVis = () => {
      if (typeof document === "undefined") return;
      if (document.visibilityState === "hidden") {
        closeStream();
      } else {
        // Catch up on whatever landed while we were hidden, THEN reopen
        // the stream from the new offset.
        api.tail(run.sessionId, run.repoPath, offsetRef.current)
          .then((payload) => { if (!stopped) applyTail(payload); })
          .catch(() => { /* ignore */ })
          .finally(() => openStream());
      }
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVis);
    }

    openStream();
    return () => {
      stopped = true;
      if (aliveSweepTimer) {
        clearTimeout(aliveSweepTimer);
        aliveSweepTimer = null;
      }
      closeStream();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVis);
      }
    };
  }, [run?.sessionId, run?.repoPath]);

  // Backward fetch: load a chunk of older entries and prepend.
  const loadOlder = useCallback(async () => {
    if (!run) return;
    if (inFlightOlderRef.current) return;
    const cur = firstOffsetRef.current;
    if (cur === null || cur <= 0) return;
    const el = logRef.current;
    if (!el) return;
    inFlightOlderRef.current = true;
    setLoadingOlder(true);
    pendingScrollRestoreRef.current = {
      prevHeight: el.scrollHeight,
      prevTop: el.scrollTop,
    };
    try {
      const result = await api.tailBefore(run.sessionId, run.repoPath, cur);
      const olderLines = (result.lines ?? []) as LogEntry[];
      const olderOffsets = Array.isArray(result.lineOffsets) ? result.lineOffsets : [];
      if (olderLines.length === 0) {
        // Nothing more upstream → mark exhausted.
        firstOffsetRef.current = result.fromOffset === 0 ? 0 : cur;
        pendingScrollRestoreRef.current = null;
        return;
      }
      // Prepend.
      setEntries((prev) => [...olderLines, ...prev]);
      entryOffsetsRef.current = [...olderOffsets, ...entryOffsetsRef.current];
      loadedOlderCountRef.current += olderLines.length;
      firstOffsetRef.current = result.fromOffset;
      // We just resurrected entries that the cap had previously dropped —
      // shrink the "earlier entries trimmed" counter to match.
      setTrimmed((t) => Math.max(0, t - olderLines.length));
    } catch {
      pendingScrollRestoreRef.current = null;
    } finally {
      inFlightOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [run]);

  // "responding…" if a new entry landed in the last 4s.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  // Authoritative source: the SSE-reported child-process state. Falls
  // back to the legacy lastTs heuristic only until the first `alive`
  // event arrives (e.g. on a brand-new SSE connection in dev), so the
  // Stop button is no longer at the mercy of "did claude write a line
  // in the last 4s" — long Bash calls / model thinking gaps used to
  // make it disappear mid-turn.
  const isResponding = aliveSse ?? (lastTs > 0 && now - lastTs < 4000);

  const visibleEntries = useMemo(
    () =>
      entries.filter((e) => {
        const k = classify(e);
        if (k === "hidden") return false;
        if (!showTools && k === "tool_result") return false;
        return true;
      }),
    [entries, showTools],
  );

  // -- Chat search (Cmd/Ctrl+F) --
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [matchIdx, setMatchIdx] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const entryKey = useCallback((e: LogEntry, fallback: number): string => {
    return (
      e.uuid ||
      e.message?.id ||
      (e.timestamp ? `${e.timestamp}:${e.type ?? ""}` : `pos-${fallback}`)
    );
  }, []);

  const matchedKeys = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [] as string[];
    const keys: string[] = [];
    visibleEntries.forEach((e, i) => {
      const c = e.message?.content;
      // Cheap text scan: stringify the content blob and substring-test.
      // JSON.stringify is enough since content blocks are JSON-serializable.
      const text = (typeof c === "string" ? c : JSON.stringify(c ?? "")).toLowerCase();
      if (text.includes(q)) keys.push(entryKey(e, i));
    });
    return keys;
  }, [searchQuery, visibleEntries, entryKey]);

  useEffect(() => { setMatchIdx(0); }, [searchQuery]);

  const scrollToMatch = useCallback((idx: number) => {
    const k = matchedKeys[idx];
    if (!k) return;
    const sel = `[data-entry-key="${(typeof CSS !== "undefined" && CSS.escape ? CSS.escape(k) : k)}"]`;
    const el = logRef.current?.querySelector(sel) as HTMLElement | null;
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("ring-2", "ring-warning/60");
    setTimeout(() => el.classList.remove("ring-2", "ring-warning/60"), 1400);
  }, [matchedKeys]);

  useEffect(() => {
    if (!searchOpen) return;
    if (matchedKeys.length === 0) return;
    scrollToMatch(matchIdx);
  }, [matchIdx, matchedKeys, scrollToMatch, searchOpen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "f") {
        // Only intercept when the chat panel is in the visible viewport
        // (ignore when user is in another part of the app).
        if (!logRef.current) return;
        const r = logRef.current.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return;
        e.preventDefault();
        setSearchOpen(true);
        setTimeout(() => searchInputRef.current?.focus(), 0);
      }
      if (e.key === "Escape" && searchOpen) {
        setSearchOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [searchOpen]);

  // Sum per-turn `message.usage` across loaded entries. The window is
  // bounded by MAX_RENDERED, so this is a *running* total over what's
  // currently in memory — not the full session. The number is still
  // useful for "how big is this conversation getting?" while typing,
  // and the task-level endpoint covers full-session totals.
  const sessionTotals = useMemo<TokenTotals>(() => {
    const t = {
      inputTokens: 0, outputTokens: 0,
      cacheCreationTokens: 0, cacheReadTokens: 0, turns: 0,
    };
    for (const e of entries) {
      if (e.type !== "assistant") continue;
      const u = e.message?.usage;
      if (!u) continue;
      t.inputTokens         += typeof u.input_tokens === "number" ? u.input_tokens : 0;
      t.outputTokens        += typeof u.output_tokens === "number" ? u.output_tokens : 0;
      t.cacheCreationTokens += typeof u.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : 0;
      t.cacheReadTokens     += typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : 0;
      t.turns += 1;
    }
    return t;
  }, [entries]);

  // Map every `tool_use_id` we've seen to its tool `name` so tool_result
  // blocks can look up which tool they are answering. Used for F.2
  // (suppressing TodoWrite confirmation noise).
  const toolNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of entries) {
      if (e.type !== "assistant") continue;
      const blocks = asBlocks(e.message?.content);
      for (const b of blocks) {
        if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
          m.set(b.id, b.name);
        }
      }
    }
    return m;
  }, [entries]);

  // The most-recent typed-user message is what gets shown in the
  // sticky bar at the top of the scroll container so the question
  // stays visible while reading tool results / assistant replies.
  // We strip the `Attached file:` boilerplate from the pinned preview
  // so it's the actual question that's visible, not the file headers.
  const userTextOf = useCallback((e: LogEntry): string => {
    const blocks = asBlocks(e.message?.content);
    const raw = blocks
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text!)
      .join(" ");
    const { stripped } = extractAttachments(raw);
    const cleaned = stripSystemTags(stripped);
    return cleaned.trim() || stripped.trim() || raw.trim();
  }, []);

  const lastUserText = useMemo(() => {
    for (let i = visibleEntries.length - 1; i >= 0; i--) {
      const e = visibleEntries[i];
      if (classify(e) !== "user") continue;
      const text = userTextOf(e);
      if (text) return text;
    }
    return "";
  }, [visibleEntries, userTextOf]);

  // Text from whichever user-message has currently scrolled above the
  // top edge. Falls through to `lastUserText` when nothing's crossed
  // yet, or when the reader is pinned to the bottom (autoScroll mode).
  const pinnedUserText = useMemo(() => {
    if (autoScroll || !pinnedUserUuid) return lastUserText;
    for (const e of visibleEntries) {
      if (e.uuid !== pinnedUserUuid) continue;
      if (classify(e) !== "user") continue;
      const text = userTextOf(e);
      if (text) return text;
      break;
    }
    return lastUserText;
  }, [autoScroll, pinnedUserUuid, visibleEntries, lastUserText, userTextOf]);

  // After a backward-load prepends rows, the scroll container's
  // scrollHeight grew by N px upstream of the user's previous viewport.
  // To prevent a jarring jump, restore the offset from the bottom:
  //   newTop = newHeight - prevHeight + prevTop
  // useLayoutEffect runs synchronously after DOM mutation, before the
  // browser paints — so the user never sees the wrong scrollTop frame.
  useLayoutEffect(() => {
    const restore = pendingScrollRestoreRef.current;
    if (!restore) return;
    const el = logRef.current;
    if (!el) {
      pendingScrollRestoreRef.current = null;
      return;
    }
    el.scrollTop = el.scrollHeight - restore.prevHeight + restore.prevTop;
    pendingScrollRestoreRef.current = null;
  }, [entries]);

  useEffect(() => {
    if (!autoScroll) return;
    // Skip auto-scroll-to-bottom if a backward load is mid-flight; the
    // layout effect above is repositioning the viewport.
    if (pendingScrollRestoreRef.current) return;
    requestAnimationFrame(() => {
      if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    });
  }, [visibleEntries, autoScroll]);

  // rAF-throttled re-evaluation of which user uuid currently sits "above
  // the top edge of the viewport" — i.e., the most recent user message
  // the reader has scrolled past. Falls back to lastUserText when nothing
  // has scrolled past yet (handled at render time).
  const recomputePinnedUuid = useCallback(() => {
    const el = logRef.current;
    if (!el) return;
    const containerTop = el.getBoundingClientRect().top;
    // Sticky header sits at containerTop and is ~28px tall; treat the
    // edge of "scrolled past" as just under it. Add a small fudge so the
    // pinned label flips at the same moment the user crosses the line.
    const threshold = containerTop + 4;
    const rows = el.querySelectorAll<HTMLDivElement>("[data-user-uuid]");
    let pickUuid: string | null = null;
    for (const row of rows) {
      const r = row.getBoundingClientRect();
      // Pick the LAST user-row whose bottom edge is at or above the top
      // threshold — i.e., the most recent message that has fully
      // scrolled past the fold.
      if (r.bottom <= threshold) {
        const uuid = row.getAttribute("data-user-uuid") || "";
        if (uuid) pickUuid = uuid;
      } else {
        break; // rows are in document order; the rest are below us.
      }
    }
    setPinnedUserUuid((prev) => (prev === pickUuid ? prev : pickUuid));
  }, []);

  // Drive recomputePinnedUuid from both an IntersectionObserver (cheap,
  // covers most cases) and a scroll listener (covers fast scrolls IO
  // would skip over). Both go through one rAF latch to avoid setState
  // storms.
  const rafScheduledRef = useRef(false);
  const schedulePinnedRecalc = useCallback(() => {
    if (rafScheduledRef.current) return;
    rafScheduledRef.current = true;
    requestAnimationFrame(() => {
      rafScheduledRef.current = false;
      recomputePinnedUuid();
    });
  }, [recomputePinnedUuid]);

  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const rows = el.querySelectorAll<HTMLDivElement>("[data-user-uuid]");
    if (rows.length === 0) return;
    const io = new IntersectionObserver(
      () => schedulePinnedRecalc(),
      { root: el, threshold: [0, 1] },
    );
    rows.forEach((r) => io.observe(r));
    // Run once immediately so the pin reflects the current scroll state
    // even if no rows actually crossed an edge yet.
    schedulePinnedRecalc();
    return () => io.disconnect();
  }, [visibleEntries, schedulePinnedRecalc]);

  const handleScroll = useCallback(() => {
    const el = logRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(atBottom);
    // Backward-load trigger: at top, with older history available.
    if (
      el.scrollTop < 32 &&
      firstOffsetRef.current !== null &&
      firstOffsetRef.current > 0 &&
      !inFlightOlderRef.current
    ) {
      void loadOlder();
    }
    schedulePinnedRecalc();
  }, [loadOlder, schedulePinnedRecalc]);

  const scrollToBottom = useCallback(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    setAutoScroll(true);
  }, []);

  const copySessionId = useCallback(async () => {
    if (!run) return;
    try {
      await navigator.clipboard.writeText(run.sessionId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { toast("error", "Clipboard blocked"); }
  }, [run, toast]);

  const onSent = useCallback(() => setAutoScroll(true), []);

  const handleRewind = useCallback(async (uuid: string) => {
    if (!run) return;
    const ok = await confirm({
      title: "Rewind to this message?",
      description: "Every later turn in this session will be dropped (the file is truncated). The active claude process, if any, may need to be restarted.",
      confirmLabel: "Rewind",
      destructive: true,
    });
    if (!ok) return;
    try {
      const r = await api.rewind(run.sessionId, { repo: run.repo, uuid });
      toast("success", `Dropped ${r.dropped} entries — kept ${r.kept}`);
      offsetRef.current = 0;
      firstOffsetRef.current = null;
      entryOffsetsRef.current = [];
      loadedOlderCountRef.current = 0;
      inFlightOlderRef.current = false;
      pendingScrollRestoreRef.current = null;
      setEntries([]);
      setTrimmed(0);
      setPinnedUserUuid(null);
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }, [run, toast, confirm]);

  const repo = useMemo(() => repos.find((r) => r.path === run?.repoPath), [repos, run?.repoPath]);

  if (!run) {
    return (
      <section className="flex-1 flex items-center justify-center text-fg-dim text-sm bg-card">
        <div className="text-center">
          <Terminal size={32} className="mx-auto mb-2 opacity-30" />
          <p>Select a run to watch its session</p>
        </div>
      </section>
    );
  }

  return (
    <section className="flex-1 min-w-0 flex flex-col bg-card relative">
      {searchOpen && (
        <div className="absolute top-2 right-3 z-30 flex items-center gap-1 rounded-md border border-border bg-card shadow-lg px-2 py-1.5 text-xs">
          <Search size={12} className="text-fg-dim shrink-0" />
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (matchedKeys.length === 0) return;
                setMatchIdx((i) => (e.shiftKey
                  ? (i - 1 + matchedKeys.length) % matchedKeys.length
                  : (i + 1) % matchedKeys.length));
              } else if (e.key === "Escape") {
                setSearchOpen(false);
              }
            }}
            placeholder="Search conversation"
            className="bg-transparent border-0 outline-none text-xs w-44 placeholder:text-fg-dim"
            aria-label="Search conversation"
          />
          <span className="text-[10px] text-fg-dim tabular-nums shrink-0 min-w-[44px] text-right">
            {searchQuery
              ? matchedKeys.length === 0
                ? "no matches"
                : `${matchIdx + 1}/${matchedKeys.length}`
              : ""}
          </span>
          <button
            type="button"
            onClick={() => matchedKeys.length && setMatchIdx((i) => (i - 1 + matchedKeys.length) % matchedKeys.length)}
            disabled={matchedKeys.length === 0}
            className="p-1 rounded text-fg-dim hover:text-foreground disabled:opacity-40"
            title="Previous match (Shift+Enter)"
            aria-label="Previous match"
          >
            <ArrowUp size={12} />
          </button>
          <button
            type="button"
            onClick={() => matchedKeys.length && setMatchIdx((i) => (i + 1) % matchedKeys.length)}
            disabled={matchedKeys.length === 0}
            className="p-1 rounded text-fg-dim hover:text-foreground disabled:opacity-40"
            title="Next match (Enter)"
            aria-label="Next match"
          >
            <ArrowDown size={12} />
          </button>
          <button
            type="button"
            onClick={() => setSearchOpen(false)}
            className="p-1 rounded text-fg-dim hover:text-foreground"
            title="Close (Esc)"
            aria-label="Close search"
          >
            <X size={12} />
          </button>
        </div>
      )}
      <header className="px-3 py-2 border-b border-border flex items-center gap-2 text-xs">
        <Terminal size={13} className="text-muted-foreground" />
        <span className="font-medium">{run.role}</span>
        {repo && <span className="text-muted-foreground">@ {repo.name}</span>}
        {isResponding && (
          <span className="inline-flex items-center gap-1 text-warning text-[10.5px]">
            <span className="relative inline-flex h-1.5 w-1.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-warning opacity-60" />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-warning" />
            </span>
            responding…
          </span>
        )}
        {sessionTotals.turns > 0 && (
          <TokenUsage
            totals={sessionTotals}
            variant="compact"
            className="ml-auto"
            title={`This window: ${sessionTotals.turns} assistant turns · in ${sessionTotals.inputTokens.toLocaleString()} · out ${sessionTotals.outputTokens.toLocaleString()} · cache read ${sessionTotals.cacheReadTokens.toLocaleString()}`}
          />
        )}
        <button
          onClick={() => {
            setSearchOpen(true);
            setTimeout(() => searchInputRef.current?.focus(), 0);
          }}
          className={`${sessionTotals.turns > 0 ? "" : "ml-auto "}inline-flex items-center gap-1 px-1.5 h-6 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-accent text-[10px] transition-colors`}
          title="Search this conversation (Ctrl/⌘+F)"
        >
          <Search size={10} /> Search
        </button>
        <button
          onClick={() => setShowTools((v) => !v)}
          className={`inline-flex items-center gap-1 px-1.5 h-6 rounded-md border text-[10px] transition-colors ${
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
          className="inline-flex items-center gap-1 px-1.5 h-6 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-accent text-[10px]"
          title="Export this conversation as Markdown"
        >
          <Download size={10} /> Export
        </button>
        <button
          onClick={copySessionId}
          className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground font-mono text-[11px]"
          title="Copy session ID"
        >
          {run.sessionId.slice(0, 8)}…
          {copied ? <Check size={11} className="text-success" /> : <Copy size={11} />}
        </button>
      </header>
      <div
        ref={logRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto font-sans text-xs leading-relaxed"
      >
        {pinnedUserText && (
          <div className="sticky top-0 z-10 backdrop-blur supports-backdrop-filter:bg-card/85 border-b border-border px-3 py-1.5">
            <p className="text-[11.5px] text-foreground line-clamp-2 wrap-break-word">
              {pinnedUserText}
            </p>
          </div>
        )}
        <div className="p-3">
          {loadingOlder && (
            <p className="text-muted-foreground italic text-[11px] text-center mb-2">
              Loading earlier messages…
            </p>
          )}
          {trimmed > 0 && (
            <p className="text-muted-foreground italic text-[11px] text-center mb-2">
              … {trimmed} earlier entries trimmed
            </p>
          )}
          {visibleEntries.length === 0 && Object.keys(partials).length === 0 ? (
            <p className="text-muted-foreground italic">Waiting for session output…</p>
          ) : (
            <>
              {visibleEntries.map((e, i) => {
                // H10: derive a STABLE key from the entry itself. The
                // previous `trimmed + i` formulation was not stable
                // across cap-trimming — when N front entries were
                // dropped, the index reset while `trimmed` advanced,
                // so unrelated entries collided on the same key. React
                // then reused DOM nodes (and therefore each LogRow's
                // memoised inner state, e.g. `ToolResultView`'s `open`)
                // across entries. Anthropic JSONL always sets `uuid`
                // per line, but we belt-and-brace to message.id and
                // timestamp+type before falling back to a positional
                // composite that at least no longer recycles after
                // trim.
                const key =
                  e.uuid ||
                  e.message?.id ||
                  (e.timestamp ? `${e.timestamp}:${e.type ?? ""}` : `pos-${trimmed + i}`);
                return (
                  <div key={key} data-entry-key={key} className="rounded-md transition-shadow">
                    <LogRow
                      entry={e}
                      sessionId={run.sessionId}
                      onRewindToHere={handleRewind}
                      toolNames={toolNames}
                      repo={run.repo}
                      prevTimestamp={visibleEntries[i - 1]?.timestamp}
                    />
                  </div>
                );
              })}
              {Object.entries(partials).map(([id, text]) =>
                text.trim() ? (
                  <StreamingAssistantRow key={`live-${id}`} text={text} />
                ) : null,
              )}
            </>
          )}
        </div>
      </div>
      {!autoScroll && visibleEntries.length > 0 && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-20 right-4 inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-primary text-primary-foreground text-[11px] font-medium shadow-lg hover:bg-primary/90 animate-slide-in"
        >
          <ArrowDown size={11} /> Jump to latest
        </button>
      )}

      <ActivityRow activity={activity} />

      <InlinePermissionRequests sessionId={run.sessionId} />

      <MessageComposer
        sessionId={run.sessionId}
        repo={run.repo}
        repoPath={run.repoPath}
        role={run.role}
        taskId={taskId}
        isResponding={isResponding}
        onSent={onSent}
        onClearConversation={onClearConversation}
      />
    </section>
  );
}

export const SessionLog = memo(
  SessionLogInner,
  (prev, next) =>
    prev.run?.sessionId === next.run?.sessionId &&
    prev.run?.repoPath === next.run?.repoPath &&
    prev.run?.role === next.run?.role &&
    prev.run?.repo === next.run?.repo &&
    prev.repos === next.repos &&
    prev.taskId === next.taskId &&
    prev.onClearConversation === next.onClearConversation,
);
