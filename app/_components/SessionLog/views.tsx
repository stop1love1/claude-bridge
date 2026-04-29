"use client";

/**
 * Leaf view components extracted from `SessionLog.tsx`.
 *
 * Each component here is self-contained: it receives all data via
 * props and owns only local state (a disclosure toggle, a verb
 * rotator, an image-dimension cache). They share no closure with the
 * outer `SessionLogInner`, so moving them into a sibling module is a
 * pure cut/paste — the parent imports + uses them exactly the same
 * way it always has.
 *
 * The `LogRow` orchestrator that composes these views stays in the
 * main file because it depends on the parent's repo / sessionId
 * resolution and the `toolNames` Map identity-comparison memo.
 */

import { memo, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  Asterisk,
  Brain,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  FileText,
  ListTodo,
  Sparkles,
  Square,
  Wrench,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "../ui/dialog";
import {
  extractImagePaths,
  prettyToolName,
  stringifyResult,
  stripSystemTags,
  summarizeInput,
  type ContentBlock,
  type ParsedAttachment,
} from "./helpers";

/**
 * Render assistant text as full GitHub-flavoured markdown: code fences,
 * inline code, headings, lists, blockquotes, tables, links, bold/italic,
 * strikethrough, task lists. Tailwind classes are scoped per-element so
 * the output matches the dark chrome of the rest of the chat.
 */
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
      // `[overflow-wrap:anywhere]` lets long unbreakable paths
      // (e.g. `apps/center/app/[locale]/finance/...tsx`) break at any
      // character so they wrap inside the message bubble instead of
      // shoving the chat scroll area wider than the mobile viewport.
      return (
        <code
          className="px-1 py-px rounded bg-secondary border border-border text-[11px] font-mono [overflow-wrap:anywhere]"
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

/**
 * Memoized so streaming token deltas don't remount the full
 * remark-gfm + react-markdown pipeline on every partial update —
 * `StreamingAssistantRow` re-renders per token but the rendered text
 * only grows incrementally.
 */
export const MarkdownText = memo(function MarkdownText({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
      {text}
    </ReactMarkdown>
  );
});

/**
 * Pretty-print a thinking-block duration:
 *   0.7 → "<1s", 12 → "12s", 130 → "2m 10s".
 */
export function formatThoughtSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  if (seconds < 1) return "<1s";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds - m * 60);
  return s ? `${m}m ${s}s` : `${m}m`;
}

export function ThinkingBlockView({
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

export function BashToolUseView({ block }: { block: ContentBlock }) {
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
export function TodoWriteView({ block }: { block: ContentBlock }) {
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

/**
 * Dedicated renderer for `Skill` tool calls. Skills (superpowers, claude-md,
 * etc.) are first-class enough in Claude Code that the CLI shows them as
 * "Using <skill> to <purpose>" rather than a generic Wrench row. Mirror
 * that — pull the skill name out of the input and surface it with a
 * Sparkles icon so it stands apart from Bash / Read / Edit calls.
 */
export function SkillToolUseView({ block }: { block: ContentBlock }) {
  const input = (block.input ?? {}) as Record<string, unknown>;
  const skillName = typeof input.skill === "string" ? input.skill : "(unknown)";
  const args = typeof input.args === "string" ? input.args.trim() : "";
  return (
    <div className="my-0.5">
      <div className="flex items-center gap-1.5 px-2 py-1 -mx-2 rounded text-[11px] text-muted-foreground">
        <Sparkles size={11} className="text-info shrink-0" />
        <span className="font-medium text-foreground shrink-0">Using skill</span>
        <code className="font-mono text-foreground truncate">{skillName}</code>
        {args && (
          <span className="text-fg-dim italic truncate opacity-80" title={args}>
            · {args.length > 80 ? args.slice(0, 80) + "…" : args}
          </span>
        )}
      </div>
    </div>
  );
}

export function ToolUseView({ block }: { block: ContentBlock }) {
  const [open, setOpen] = useState(false);
  const rawName = block.name ?? "tool";
  if (rawName === "Bash") return <BashToolUseView block={block} />;
  if (rawName === "TodoWrite") return <TodoWriteView block={block} />;
  if (rawName === "Skill") return <SkillToolUseView block={block} />;
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

export function ImageRefLink({ path, repo }: { path: string; repo?: string }) {
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

export function ToolResultView({ block, suppress, repo }: { block: ContentBlock; suppress?: boolean; repo?: string }) {
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
export function ActivityRow({
  activity,
}: {
  activity: { kind: "thinking" | "running" | "idle"; label?: string };
}) {
  const [verbIdx, setVerbIdx] = useState(0);
  // Wall-clock seconds since the current activity started — same spinner
  // counter the Claude Code CLI shows beside its verb. Reset whenever the
  // activity kind flips so a thinking→running transition restarts the
  // count instead of carrying the prior interval over.
  const [elapsed, setElapsed] = useState(0);
  const startedAtRef = useRef<number | null>(null);

  // Rotate the filler verb every 2.4s while in thinking state. We don't
  // rotate during "running" — the task description is the actual signal.
  useEffect(() => {
    if (activity.kind !== "thinking") return;
    const t = setInterval(() => {
      setVerbIdx((i) => (i + 1) % THINKING_VERBS.length);
    }, 2400);
    return () => clearInterval(t);
  }, [activity.kind]);

  useEffect(() => {
    if (activity.kind === "idle") {
      startedAtRef.current = null;
      setElapsed(0);
      return;
    }
    startedAtRef.current = Date.now();
    setElapsed(0);
    const t = setInterval(() => {
      if (startedAtRef.current === null) return;
      setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000));
    }, 1000);
    return () => clearInterval(t);
  }, [activity.kind, activity.label]);

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
      {elapsed > 0 && (
        <span className="text-fg-dim tabular-nums">· {elapsed}s</span>
      )}
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
export function StreamingAssistantRow({ text }: { text: string }) {
  // Same scaffolding-tag suppression as the settled `TextBlockView`.
  // Streaming text may be mid-tag (e.g. just `<task-no…`) — strip what
  // we can and fall through; the final settled message will be cleaned
  // again with the now-complete buffer.
  const cleaned = stripSystemTags(text);
  if (!cleaned.trim()) {
    // Render only the caret while the buffer is pure scaffolding so the
    // user sees the assistant is still typing without staring at raw
    // protocol bytes.
    return (
      <div className="my-2 space-y-1">
        <div className="leading-relaxed">
          <span
            className="inline-block w-1.5 h-3 align-text-bottom bg-foreground/70 animate-pulse"
            aria-hidden="true"
          />
        </div>
      </div>
    );
  }
  return (
    <div className="my-2 space-y-1">
      <div className="leading-relaxed">
        <MarkdownText text={cleaned} />
        <span
          className="inline-block w-1.5 h-3 ml-0.5 align-text-bottom bg-foreground/70 animate-pulse"
          aria-hidden="true"
        />
      </div>
    </div>
  );
}

export function TextBlockView({ text, role }: { text: string; role: "user" | "assistant" }) {
  if (!text) return null;
  if (role === "user") {
    return <div className="whitespace-pre-wrap wrap-break-word">{text}</div>;
  }
  // Assistants sometimes echo bridge scaffolding (e.g.
  // `<task-notification><task-id>…</task-id>…</task-notification>` when
  // they paraphrase a Monitor event the bridge fed them). Strip those
  // before handing to MarkdownText so the user sees prose, not the
  // protocol envelope. Only well-known tag names are stripped.
  const cleaned = stripSystemTags(text);
  if (!cleaned.trim()) return null;
  return (
    <div className="leading-relaxed">
      <MarkdownText text={cleaned} />
    </div>
  );
}

/**
 * Render a base64 image content block (Anthropic vision input). Same look
 * as `AttachmentChip` so a paste / IDE-attached screenshot is visually
 * indistinguishable from a composer-uploaded one. Click to open full
 * size in a new tab.
 */
export function InlineImage({ src }: { src: { mediaType: string; data: string } }) {
  const url = `data:${src.mediaType};base64,${src.data}`;
  // Read natural dimensions on load so the chip can label the image
  // `544×395` like Slack / Discord attachments. base64 inflates ~33%
  // so payload bytes ≈ data.length * 0.75.
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const approxKb = Math.round((src.data.length * 0.75) / 1024);
  const ext = src.mediaType.replace(/^image\//, "").toLowerCase();
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 px-1.5 py-1 rounded-md border border-border bg-background hover:bg-accent text-[11px] max-w-full"
          title="Click to preview"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={url}
            alt="pasted image"
            onLoad={(e) => {
              const img = e.currentTarget;
              if (img.naturalWidth && img.naturalHeight) {
                setDims({ w: img.naturalWidth, h: img.naturalHeight });
              }
            }}
            className="h-5 w-5 rounded object-cover shrink-0"
          />
          <span className="font-medium text-foreground truncate">image.{ext}</span>
          <span className="text-muted-foreground tabular-nums shrink-0">
            {dims ? `${dims.w}×${dims.h}` : `${approxKb.toLocaleString()} KB`}
          </span>
        </button>
      </DialogTrigger>
      {/* `max-w-[min(92vw,1200px)]` overrides DialogContent's default
          `max-w-lg` so a screenshot can use the full viewport. `p-2`
          tightens the chrome so the image is the focus, not the frame. */}
      <DialogContent className="max-w-[min(92vw,1200px)] p-2 gap-2">
        {/* Radix requires a DialogTitle on every DialogContent for screen
            readers. The visual chrome is already obvious (image + caption),
            so hide the title visually with `sr-only`. */}
        <DialogTitle className="sr-only">image.{ext} preview</DialogTitle>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="block"
          title="Open in a new tab"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={url}
            alt="pasted image preview"
            className="max-h-[80vh] w-auto mx-auto rounded object-contain"
          />
        </a>
        <div className="text-[11px] text-muted-foreground font-mono text-center">
          image.{ext}
          {dims && <span className="ml-2">{dims.w}×{dims.h}</span>}
          <span className="ml-2">{approxKb.toLocaleString()} KB</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function AttachmentChip({
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
