// Pure view fragments for SessionLog. Splits the row renderers out of
// the main component so the index file stays focused on data flow.
//
// Ported from main's `app/_components/SessionLog/views.tsx`:
//   - MD_COMPONENTS + MarkdownText (assistant text → react-markdown + GFM)
//   - BashToolUseView, TodoWriteView, SkillToolUseView (per-tool renderers)
//   - ToolUseView dispatches on tool name, falls back to GenericToolUseView
//   - ToolResultView strips system tags + emits ImageRefLink thumbnails
//   - ActivityRow ("Thinking…" / "Running: …" pulse + elapsed counter)
//   - InlineImage (base64 image content blocks, click → Radix Dialog preview)
//   - ImageRefLink (repo-relative path images, /api/repos/<repo>/raw?path=…)
//
// What we *don't* have yet (TODO when SSE lands):
//   - StreamingAssistantRow (needs partialsStore wired to live SSE stream)
//   - SSE-driven activity (we feed ActivityRow a heuristic from index.tsx)

import { memo, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  Asterisk,
  Brain,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  FileText,
  Image as ImageIcon,
  ListTodo,
  Sparkles,
  Square,
  Terminal,
  Wrench,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "@/api/client";
import { cn } from "@/lib/cn";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  asBlocks,
  classify,
  extractAttachments,
  extractImagePaths,
  prettyToolName,
  stringifyResult,
  stripSystemTags,
  summarizeInput,
  type ContentBlock,
  type LogEntry,
  type ParsedAttachment,
} from "./helpers";

/** ~3 KB cap on rendered tool input/output. Beyond that → "[truncated]". */
const TOOL_CAP = 3_000;

/**
 * Render assistant text as full GitHub-flavoured markdown: code fences,
 * inline code, headings, lists, blockquotes, tables, links, bold/italic,
 * strikethrough, task lists.
 */
const MD_COMPONENTS = {
  p: (p: React.HTMLAttributes<HTMLParagraphElement>) => (
    <p className="my-1 break-words whitespace-pre-wrap" {...p} />
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
    <li className="break-words" {...p} />
  ),
  blockquote: (p: React.BlockquoteHTMLAttributes<HTMLQuoteElement>) => (
    <blockquote
      className="border-l-2 border-border pl-3 my-1 text-muted-foreground italic"
      {...p}
    />
  ),
  hr: () => <hr className="my-2 border-border" />,
  a: (p: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a
      className="text-primary hover:underline"
      target="_blank"
      rel="noopener noreferrer"
      {...p}
    />
  ),
  strong: (p: React.HTMLAttributes<HTMLElement>) => (
    <strong className="font-semibold text-foreground" {...p} />
  ),
  em: (p: React.HTMLAttributes<HTMLElement>) => <em className="italic" {...p} />,
  del: (p: React.HTMLAttributes<HTMLElement>) => (
    <del className="text-fg-dim" {...p} />
  ),
  table: (p: React.TableHTMLAttributes<HTMLTableElement>) => (
    <div className="my-1.5 overflow-x-auto">
      <table className="text-[11px] border-collapse" {...p} />
    </div>
  ),
  thead: (p: React.HTMLAttributes<HTMLTableSectionElement>) => <thead {...p} />,
  tbody: (p: React.HTMLAttributes<HTMLTableSectionElement>) => <tbody {...p} />,
  tr: (p: React.HTMLAttributes<HTMLTableRowElement>) => <tr {...p} />,
  th: (p: React.ThHTMLAttributes<HTMLTableCellElement>) => (
    <th
      className="border border-border px-2 py-1 bg-secondary text-left font-semibold"
      {...p}
    />
  ),
  td: (p: React.TdHTMLAttributes<HTMLTableCellElement>) => (
    <td className="border border-border px-2 py-1 align-top" {...p} />
  ),
  code: (props: React.HTMLAttributes<HTMLElement>) => {
    const { className, children, ...rest } = props;
    // react-markdown v10 dropped the `inline` prop, so we have to
    // distinguish ourselves: fenced code blocks come through with a
    // `language-foo` class set by the parser; inline backticks never do.
    const lang = /language-([\w-]+)/.exec(className ?? "")?.[1];
    if (!lang) {
      return (
        <code
          className="px-1 py-px rounded bg-muted/50 border border-border text-[11px] font-mono [overflow-wrap:anywhere]"
          {...rest}
        >
          {children}
        </code>
      );
    }
    return (
      <code className={cn("font-mono text-[11.5px]", className)} {...rest}>
        <span className="block text-[9px] uppercase tracking-wider text-fg-dim mb-1 select-none">
          {lang}
        </span>
        {children}
      </code>
    );
  },
  pre: (p: React.HTMLAttributes<HTMLPreElement>) => (
    <pre
      className="my-1.5 rounded bg-card border border-border px-2.5 py-2 text-xs overflow-x-auto"
      {...p}
    />
  ),
  input: (p: React.InputHTMLAttributes<HTMLInputElement>) =>
    p.type === "checkbox" ? (
      <input className="mr-1 align-middle" disabled {...p} />
    ) : (
      <input {...p} />
    ),
};

/**
 * Memoized so adjacent re-renders (search, scroll-pin) don't remount
 * the full remark-gfm pipeline on every parent tick.
 */
export const MarkdownText = memo(function MarkdownText({
  text,
}: {
  text: string;
}) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
      {text}
    </ReactMarkdown>
  );
});

// -- Main row dispatcher -------------------------------------------------

export const LogRow = memo(
  function LogRow({
    entry,
    sessionId,
    onRewind,
    repo,
    searchQuery,
  }: {
    entry: LogEntry;
    sessionId?: string;
    repo?: string;
    onRewind?: (uuid: string) => void;
    searchQuery?: string;
  }) {
    const kind = classify(entry);
    if (kind === "hidden") return null;
    if (kind === "user")
      return (
        <UserRow
          entry={entry}
          onRewind={onRewind}
          sessionId={sessionId}
          searchQuery={searchQuery}
        />
      );
    if (kind === "assistant")
      return <AssistantRow entry={entry} searchQuery={searchQuery} />;
    if (kind === "tool_result")
      return <ToolResultRow entry={entry} repo={repo} />;
    return null;
  },
  (prev, next) => {
    // Re-render only on meaningful prop changes. Same per-uuid /
    // per-timestamp comparison main uses — avoids re-mounting tool-row
    // disclosure state every poll tick.
    if (prev.entry !== next.entry) {
      // entries[] is rebuilt on every fetch; the inner content is
      // reference-equal because we splat the same array slot.
      if (prev.entry.uuid !== next.entry.uuid) return false;
      if (prev.entry.timestamp !== next.entry.timestamp) return false;
      if (prev.entry.message?.content !== next.entry.message?.content)
        return false;
    }
    if (prev.sessionId !== next.sessionId) return false;
    if (prev.repo !== next.repo) return false;
    if (prev.onRewind !== next.onRewind) return false;
    if (prev.searchQuery !== next.searchQuery) return false;
    return true;
  },
);

// -- User row ------------------------------------------------------------

function UserRow({
  entry,
  sessionId,
  onRewind,
  searchQuery,
}: {
  entry: LogEntry;
  sessionId?: string;
  onRewind?: (uuid: string) => void;
  searchQuery?: string;
}) {
  const blocks = asBlocks(entry.message?.content);
  // Three sources of imagery on a user message:
  //   1. composer-upload `Attached file: \`<path>\`` text marker → AttachmentChip
  //   2. inline `image` content blocks (paste, IDE attach) → InlineImage
  //   3. plain text → bubble with optional GFM-stripped preview
  const textParts: string[] = [];
  const inlineImages: Array<{ mediaType: string; data: string }> = [];
  for (const b of blocks) {
    if (b.type === "text" && typeof b.text === "string") {
      textParts.push(b.text);
    } else if (
      b.type === "image" &&
      b.source?.type === "base64" &&
      typeof b.source.data === "string" &&
      typeof b.source.media_type === "string"
    ) {
      inlineImages.push({
        mediaType: b.source.media_type,
        data: b.source.data,
      });
    }
  }
  const raw = textParts.join("\n\n");
  const { stripped, items } = extractAttachments(raw);
  const text = stripSystemTags(stripped);
  if (!text && items.length === 0 && inlineImages.length === 0) return null;
  return (
    <div
      className="group flex justify-end px-4 py-2"
      data-user-uuid={entry.uuid ?? ""}
    >
      <div className="max-w-[78%] rounded-sm border border-primary/30 bg-primary/10 px-3 py-2">
        <div className="mb-1 flex items-center justify-between gap-3">
          <span className="font-mono text-micro uppercase tracking-wideish text-primary">
            user
          </span>
          {entry.uuid && onRewind && (
            <button
              type="button"
              onClick={() => onRewind(entry.uuid as string)}
              className="invisible font-mono text-[10px] uppercase tracking-wideish text-muted-foreground hover:text-primary group-hover:visible"
              title="rewind to before this turn"
            >
              rewind
            </button>
          )}
        </div>
        {inlineImages.length > 0 && (
          <div className="mb-2 flex flex-col gap-1.5">
            {inlineImages.map((img, i) => (
              <InlineImage key={`img-${i}`} src={img} />
            ))}
          </div>
        )}
        {text && (
          <pre className="whitespace-pre-wrap break-words font-sans text-small text-foreground">
            {highlightMatches(text, searchQuery)}
          </pre>
        )}
        {items.length > 0 && sessionId && (
          <div className="mt-2 flex flex-wrap gap-2">
            {items.map((it, i) => (
              <AttachmentChip
                key={`${it.name}-${i}`}
                att={it}
                sessionId={sessionId}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// -- Assistant row + blocks ---------------------------------------------

function AssistantRow({
  entry,
  searchQuery,
}: {
  entry: LogEntry;
  searchQuery?: string;
}) {
  const blocks = asBlocks(entry.message?.content);
  if (blocks.length === 0) return null;
  return (
    <div className="px-4 py-2">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="font-mono text-micro uppercase tracking-wideish text-muted-foreground">
          assistant
        </span>
        {entry.timestamp && (
          <span className="font-mono text-[10px] tabular-nums text-fg-dim">
            {new Date(entry.timestamp).toLocaleTimeString()}
          </span>
        )}
      </div>
      <div className="space-y-2">
        {blocks.map((b, i) => (
          <AssistantBlock block={b} key={i} searchQuery={searchQuery} />
        ))}
      </div>
    </div>
  );
}

function AssistantBlock({
  block,
  searchQuery,
}: {
  block: ContentBlock;
  searchQuery?: string;
}) {
  if (block.type === "text" && block.text) {
    const text = stripSystemTags(block.text);
    if (!text) return null;
    // When searching, fall back to plain pre so highlight marks resolve
    // — markdown rendering would obscure the <mark> wrapping.
    if (searchQuery && searchQuery.trim()) {
      return (
        <pre className="whitespace-pre-wrap break-words font-sans text-small leading-relaxed text-foreground">
          {highlightMatches(text, searchQuery)}
        </pre>
      );
    }
    return (
      <div className="font-sans text-small leading-relaxed text-foreground">
        <MarkdownText text={text} />
      </div>
    );
  }
  if (block.type === "thinking" && block.thinking) {
    return <ThinkingBlockView text={block.thinking} />;
  }
  if (block.type === "tool_use") {
    return <ToolUseBlock block={block} />;
  }
  return null;
}

function ThinkingBlockView({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const hasContent = text.trim().length > 0;
  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => hasContent && setOpen((v) => !v)}
        className={cn(
          "inline-flex items-center gap-1 text-[10.5px] italic text-fg-dim",
          hasContent ? "cursor-pointer hover:text-foreground" : "cursor-default",
        )}
        title={hasContent ? "Toggle chain-of-thought" : "Thinking content is not available"}
      >
        {hasContent ? (
          open ? (
            <ChevronDown size={11} />
          ) : (
            <ChevronRight size={11} />
          )
        ) : (
          <span className="inline-block w-[11px]" />
        )}
        <Brain size={11} className="text-info" />
        <span className="font-medium not-italic text-fg-dim">Thought</span>
        <span className="opacity-60">
          · {hasContent ? `${text.length.toLocaleString()} chars` : "redacted"}
        </span>
      </button>
      {open && hasContent && (
        <pre className="mt-1 px-2 py-1.5 rounded bg-card border border-border text-[11px] text-muted-foreground whitespace-pre-wrap break-words">
          {text}
        </pre>
      )}
    </div>
  );
}

// -- Per-tool renderers --------------------------------------------------

function ToolUseBlock({ block }: { block: ContentBlock }) {
  const name = block.name ?? "tool";
  if (name === "Bash" || name === "shell" || name === "bash") {
    return <BashToolUseView block={block} />;
  }
  if (name === "TodoWrite") return <TodoWriteView block={block} />;
  if (name === "Skill") return <SkillToolUseView block={block} />;
  return <GenericToolUseView block={block} />;
}

function BashToolUseView({ block }: { block: ContentBlock }) {
  const [open, setOpen] = useState(false);
  const input = (block.input ?? {}) as Record<string, unknown>;
  const command = typeof input.command === "string" ? input.command : "";
  const description =
    typeof input.description === "string" ? input.description : "";
  const oneLine = command.replace(/\s*\n\s*/g, " ").trim();
  const TRUNC = 140;
  const truncated = oneLine.length > TRUNC;
  const preview = truncated ? oneLine.slice(0, TRUNC) + "…" : oneLine;
  const multiline = command.includes("\n");
  const expandable = truncated || multiline;
  return (
    <div className="rounded-sm border border-border bg-secondary/40">
      <button
        type="button"
        onClick={() => expandable && setOpen((v) => !v)}
        className={cn(
          "flex w-full items-start gap-2 px-3 py-1.5 text-left",
          expandable ? "cursor-pointer hover:bg-secondary" : "cursor-default",
        )}
      >
        {expandable ? (
          open ? (
            <ChevronDown size={12} className="mt-0.5 shrink-0 text-fg-dim" />
          ) : (
            <ChevronRight size={12} className="mt-0.5 shrink-0 text-fg-dim" />
          )
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <Terminal size={12} className="mt-0.5 shrink-0 text-primary" />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-[11px] text-foreground">
            <span className="mr-1 select-none text-fg-dim">$</span>
            {open ? command : preview}
          </span>
          {description && (
            <span className="mt-0.5 block truncate text-[10px] italic text-fg-dim">
              {description}
            </span>
          )}
        </span>
      </button>
    </div>
  );
}

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
    <div className="rounded-sm border border-border bg-secondary/30 px-3 py-2">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-foreground">
        <ListTodo size={11} className="text-info" />
        Update Todos
      </div>
      <ul className="mt-1 ml-1 space-y-0.5">
        {todos.map((t, i) => {
          const inProgress = t.status === "in_progress";
          const done = t.status === "completed";
          const text = inProgress ? t.activeForm || t.content : t.content;
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
            <li
              key={i}
              className="flex items-start gap-1.5 text-[11px] leading-snug"
            >
              <Icon size={11} className={cn("mt-0.5 shrink-0", iconCls)} />
              <span className={cn("break-words", textCls)}>{text}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function SkillToolUseView({ block }: { block: ContentBlock }) {
  const input = (block.input ?? {}) as Record<string, unknown>;
  const skillName =
    typeof input.skill === "string" ? input.skill : "(unknown)";
  const args = typeof input.args === "string" ? input.args.trim() : "";
  return (
    <div className="rounded-sm border border-border bg-secondary/30 px-3 py-1.5">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Sparkles size={11} className="shrink-0 text-info" />
        <span className="shrink-0 font-medium text-foreground">Using skill</span>
        <code className="truncate font-mono text-foreground">{skillName}</code>
        {args && (
          <span
            className="truncate italic opacity-80 text-fg-dim"
            title={args}
          >
            · {args.length > 80 ? args.slice(0, 80) + "…" : args}
          </span>
        )}
      </div>
    </div>
  );
}

function GenericToolUseView({ block }: { block: ContentBlock }) {
  const [open, setOpen] = useState(false);
  const name = prettyToolName(block.name ?? "tool");
  const summary = summarizeInput(block.input);
  const json = JSON.stringify(block.input ?? {}, null, 2);
  const truncated = json.length > TOOL_CAP;
  return (
    <div className="rounded-sm border border-border bg-secondary/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-secondary"
      >
        {open ? (
          <ChevronDown size={12} className="text-fg-dim" />
        ) : (
          <ChevronRight size={12} className="text-fg-dim" />
        )}
        <Wrench size={12} className="text-primary" />
        <span className="font-mono text-micro uppercase tracking-wideish text-foreground">
          {name}
        </span>
        {summary && (
          <span className="truncate font-mono text-micro text-fg-dim">
            {summary}
          </span>
        )}
      </button>
      {open && (
        <pre className="overflow-x-auto border-t border-border bg-background px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
          {truncated ? json.slice(0, TOOL_CAP) + "\n\n[truncated]" : json}
        </pre>
      )}
    </div>
  );
}

// -- Tool result row -----------------------------------------------------

function ToolResultRow({ entry, repo }: { entry: LogEntry; repo?: string }) {
  const blocks = asBlocks(entry.message?.content);
  const result = blocks.find((b) => b.type === "tool_result");
  if (!result) return null;
  const isError = !!result.is_error;
  const rawText = stringifyResult(result.content);
  const text = stripSystemTags(rawText);
  const images = extractImagePaths(text);
  if (!text && images.length === 0) return null;
  const truncated = text.length > TOOL_CAP;
  const display = truncated ? text.slice(0, TOOL_CAP) + "\n\n[truncated]" : text;
  const [open, setOpen] = useState(false);
  return (
    <div className="px-4 py-1">
      {text && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={cn(
            "flex w-full items-center gap-2 rounded-sm border px-3 py-1.5 text-left hover:bg-secondary",
            isError
              ? "border-status-blocked/40 bg-status-blocked/5"
              : "border-border bg-card/40",
          )}
        >
          {open ? (
            <ChevronDown size={12} className="text-fg-dim" />
          ) : (
            <ChevronRight size={12} className="text-fg-dim" />
          )}
          {isError ? (
            <AlertCircle size={12} className="text-status-blocked" />
          ) : (
            <FileText size={12} className="text-fg-dim" />
          )}
          <span
            className={cn(
              "font-mono text-micro uppercase tracking-wideish",
              isError ? "text-status-blocked" : "text-muted-foreground",
            )}
          >
            {isError ? "tool_error" : "tool_result"}
          </span>
          <span className="truncate font-mono text-micro text-fg-dim">
            {display.replace(/\s+/g, " ").trim().slice(0, 90)}
          </span>
        </button>
      )}
      {open && text && (
        <pre className="mt-1 overflow-x-auto rounded-sm border border-border bg-background px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground whitespace-pre-wrap break-words">
          {display}
        </pre>
      )}
      {images.map((p, i) => (
        <ImageRefLink key={`${p}-${i}`} path={p} repo={repo} />
      ))}
    </div>
  );
}

// -- Image previews ------------------------------------------------------

/**
 * Render a base64 image content block (Anthropic vision input). Click
 * to open full-size in a Radix Dialog.
 */
export function InlineImage({
  src,
}: {
  src: { mediaType: string; data: string };
}) {
  const url = `data:${src.mediaType};base64,${src.data}`;
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const approxKb = Math.round((src.data.length * 0.75) / 1024);
  const ext = src.mediaType.replace(/^image\//, "").toLowerCase();
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-background px-1.5 py-1 text-[11px] hover:bg-secondary"
          title="Click to preview"
        >
          <img
            src={url}
            alt="pasted image"
            onLoad={(e) => {
              const img = e.currentTarget;
              if (img.naturalWidth && img.naturalHeight) {
                setDims({ w: img.naturalWidth, h: img.naturalHeight });
              }
            }}
            className="h-5 w-5 shrink-0 rounded object-cover"
          />
          <span className="truncate font-medium text-foreground">
            image.{ext}
          </span>
          <span className="shrink-0 tabular-nums text-muted-foreground">
            {dims ? `${dims.w}×${dims.h}` : `${approxKb.toLocaleString()} KB`}
          </span>
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-[min(92vw,1200px)] gap-2 p-2">
        <DialogTitle className="sr-only">image.{ext} preview</DialogTitle>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="block"
          title="Open in a new tab"
        >
          <img
            src={url}
            alt="pasted image preview"
            className="mx-auto max-h-[80vh] w-auto rounded object-contain"
          />
        </a>
        <div className="text-center font-mono text-[11px] text-muted-foreground">
          image.{ext}
          {dims && (
            <span className="ml-2">
              {dims.w}×{dims.h}
            </span>
          )}
          <span className="ml-2">{approxKb.toLocaleString()} KB</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Repo-relative image path embedded in a tool_result. The Go backend's
 * `/api/repos/{name}/raw` returns JSON metadata, not raw bytes — so the
 * `<img src>` will fail to load and we degrade to a "could not load
 * preview" message + the raw path. When the binary route gets ported,
 * this component automatically lights up because the URL is built the
 * same way main does.
 */
function ImageRefLink({ path, repo }: { path: string; repo?: string }) {
  const [open, setOpen] = useState(false);
  const [errored, setErrored] = useState(false);
  const name = path.split(/[\\/]/).pop() ?? path;
  const url = repo
    ? `/api/repos/${encodeURIComponent(repo)}/raw?path=${encodeURIComponent(path)}`
    : null;
  return (
    <div className="my-1 ml-5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 font-mono text-[11px] text-primary hover:underline"
        title={url ? "Toggle preview" : "Image referenced by tool"}
      >
        {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        <ImageIcon size={10} />
        {name}
      </button>
      {open &&
        (url && !errored ? (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 block max-w-md"
            title="Open full size in a new tab"
          >
            <img
              src={url}
              alt={name}
              onError={() => setErrored(true)}
              className="max-h-72 max-w-full rounded-md border border-border bg-background object-contain transition-colors hover:border-primary"
            />
            <div className="mt-1 break-all font-mono text-[10px] text-muted-foreground">
              {path}
            </div>
          </a>
        ) : (
          <pre className="mt-1 rounded-sm bg-muted/40 px-2 py-1 font-mono text-[10.5px] text-muted-foreground whitespace-pre-wrap break-words">
            {path}
            {errored && (
              <span className="mt-1 block text-status-blocked/80">
                Could not load preview (file may be outside the repo or
                unsupported).
              </span>
            )}
          </pre>
        ))}
    </div>
  );
}

function AttachmentChip({
  att,
  sessionId,
}: {
  att: ParsedAttachment;
  sessionId: string;
}) {
  const url = api.uploads.fileUrl(sessionId, att.name);
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1.5 rounded-sm border border-border bg-background px-2 py-1 font-mono text-micro text-muted-foreground hover:border-primary/40 hover:text-primary"
    >
      {att.isImage ? <ImageIcon size={11} /> : <FileText size={11} />}
      {att.name}
      {att.size != null && (
        <span className="tabular-nums text-fg-dim">
          {(att.size / 1024).toFixed(1)}KB
        </span>
      )}
    </a>
  );
}

// -- Activity row --------------------------------------------------------

const THINKING_VERBS = [
  "Thinking",
  "Reasoning",
  "Reflecting",
  "Planning",
  "Pondering",
  "Brewing",
];

/**
 * Status row above the composer. Mirrors the bottom-line indicator the
 * Claude Code CLI puts in its terminal screen — "Thinking…" or
 * "Running: <tool>". When `kind: "idle"` the row collapses (returns null).
 *
 * TODO: when SSE 'status' events land, drive directly from event.tool —
 * the existing prop-shape already mirrors what main feeds in.
 */
export function ActivityRow({
  activity,
}: {
  activity: { kind: "thinking" | "running" | "idle"; label?: string };
}) {
  const [verbIdx, setVerbIdx] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const startedAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (activity.kind !== "thinking") return;
    const t = setInterval(() => {
      setVerbIdx((i) => (i + 1) % THINKING_VERBS.length);
    }, 1500);
    return () => clearInterval(t);
  }, [activity.kind]);

  useEffect(() => {
    if (activity.kind === "idle") {
      startedAtRef.current = null;
      void Promise.resolve().then(() => setElapsed(0));
      return;
    }
    startedAtRef.current = Date.now();
    void Promise.resolve().then(() => setElapsed(0));
    const t = setInterval(() => {
      if (startedAtRef.current === null) return;
      setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000));
    }, 1000);
    return () => clearInterval(t);
  }, [activity.kind, activity.label]);

  if (activity.kind === "idle") return null;
  const isThinking = activity.kind === "thinking";
  const verb = isThinking
    ? THINKING_VERBS[verbIdx]
    : activity.label || "task";
  const icon = isThinking ? (
    <span
      className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground/70"
      aria-hidden="true"
    />
  ) : (
    <Asterisk
      size={11}
      className="animate-pulse text-warning"
      aria-hidden="true"
    />
  );
  return (
    <div className="flex shrink-0 items-center gap-1.5 border-t border-border bg-card/60 px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
      {icon}
      <span className={isThinking ? "italic" : "font-medium text-foreground"}>
        {verb}…
      </span>
      {elapsed > 0 && (
        <span className="tabular-nums text-fg-dim">· {elapsed}s</span>
      )}
    </div>
  );
}

// -- Search highlighting -------------------------------------------------

/**
 * Wrap occurrences of `query` in <mark>; case-insensitive.
 * Empty query returns the original text unchanged.
 */
function highlightMatches(
  text: string,
  query: string | undefined,
): React.ReactNode {
  if (!query) return text;
  const q = query.trim();
  if (!q) return text;
  const lc = text.toLowerCase();
  const lcq = q.toLowerCase();
  const out: React.ReactNode[] = [];
  let i = 0;
  let n = 0;
  while (i < text.length) {
    const idx = lc.indexOf(lcq, i);
    if (idx === -1) {
      out.push(text.slice(i));
      break;
    }
    if (idx > i) out.push(text.slice(i, idx));
    out.push(
      <mark
        key={`m-${n++}`}
        className="rounded-sm bg-warning/40 ring-1 ring-warning/60"
      >
        {text.slice(idx, idx + lcq.length)}
      </mark>,
    );
    i = idx + lcq.length;
  }
  return out;
}
