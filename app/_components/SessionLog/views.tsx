"use client";


import { memo, useEffect, useRef, useState } from "react";
import { Highlight, themes, type Language } from "prism-react-renderer";
import {
  AlertCircle,
  Asterisk,
  Brain,
  Check,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  FileText,
  ListTodo,
  MessageCircleQuestion,
  Sparkles,
  Square,
  Wrench,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "../ui/dialog";
import { cn } from "@/libs/cn";
import {
  buildAnswerMessage,
  extractImagePaths,
  parseAskUserQuestion,
  prettyToolName,
  stringifyResult,
  stripSystemTags,
  summarizeInput,
  type ContentBlock,
  type ParsedAttachment,
} from "./helpers";

function childrenToText(node: React.ReactNode): string {
  if (node == null || node === false || node === true) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(childrenToText).join("");
  if (typeof node === "object" && "props" in node) {
    const props = (node as React.ReactElement<{ children?: React.ReactNode }>).props;
    return childrenToText(props.children);
  }
  return "";
}

const LANG_ALIAS: Record<string, Language> = {
  ts: "tsx", typescript: "tsx", tsx: "tsx",
  js: "jsx", javascript: "jsx", jsx: "jsx",
  json: "json", json5: "json",
  py: "python", python: "python",
  sh: "bash", bash: "bash", shell: "bash", zsh: "bash",
  yml: "yaml", yaml: "yaml",
  md: "markdown", markdown: "markdown",
  html: "markup", xml: "markup", svg: "markup",
  css: "css", scss: "css",
  sql: "sql",
  go: "go", rust: "rust", java: "java",
};

const HighlightedCode: React.FC<{ lang: string; text: string }> = ({ lang, text }) => {
  const prismLang = LANG_ALIAS[lang.toLowerCase()] ?? ("tsx" as Language);
  return (
    <Highlight code={text} language={prismLang} theme={themes.vsDark}>
      {({ tokens, getLineProps, getTokenProps }) => (
        <pre
          className="my-1.5 rounded bg-[#1e1e1e] border border-border px-2.5 py-2 overflow-x-auto text-[11.5px] leading-relaxed"
          style={{ margin: 0 }}
        >
          <span className="block text-[9px] uppercase tracking-wider text-fg-dim mb-1 select-none">
            {lang}
          </span>
          {tokens.map((line, i) => {
            const lineProps = getLineProps({ line });
            return (
              <div key={i} {...lineProps}>
                {line.map((token, key) => (
                  <span key={key} {...getTokenProps({ token })} />
                ))}
              </div>
            );
          })}
        </pre>
      )}
    </Highlight>
  );
};
HighlightedCode.displayName = "HighlightedCode";

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
  a: ({ href, ...p }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => {
    const safe = href && /^(https?:|mailto:)/i.test(href) ? href : undefined;
    return (
      <a
        className="text-primary hover:underline"
        target="_blank"
        rel="noopener noreferrer"
        href={safe}
        {...p}
      />
    );
  },
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
    const lang = /language-([\w-]+)/.exec(className ?? "")?.[1];
    if (!lang) {
      return (
        <code
          className="px-1 py-px rounded bg-secondary border border-border text-[11px] font-mono wrap-anywhere"
          {...rest}
        >
          {children}
        </code>
      );
    }
    const text = childrenToText(children).replace(/\n$/, "");
    return <HighlightedCode lang={lang} text={text} />;
  },
  pre: (p: React.HTMLAttributes<HTMLPreElement>) => {
    const child = (p.children as React.ReactElement | undefined);
    const isHighlighted =
      child && typeof child === "object" && "type" in child &&
      (child.type as { displayName?: string }).displayName === "HighlightedCode";
    if (isHighlighted) return <>{p.children}</>;
    return (
      <pre
        className="my-1.5 rounded bg-background border border-border px-2.5 py-2 overflow-x-auto"
        {...p}
      />
    );
  },
  input: (p: React.InputHTMLAttributes<HTMLInputElement>) =>
    p.type === "checkbox"
      ? <input className="mr-1 align-middle" disabled {...p} />
      : <input {...p} />,
};

export const MarkdownText = memo(function MarkdownText({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
      {text}
    </ReactMarkdown>
  );
});

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

function ChoiceMark({ selected, multi }: { selected: boolean; multi: boolean }) {
  return (
    <span
      className={cn(
        "mt-0.5 shrink-0 h-3.5 w-3.5 border flex items-center justify-center transition-colors",
        multi ? "rounded-[3px]" : "rounded-full",
        selected ? "border-primary bg-primary" : "border-muted-foreground/40",
      )}
    >
      {selected &&
        (multi ? (
          <Check size={10} className="text-primary-foreground" />
        ) : (
          <span className="h-1.5 w-1.5 rounded-full bg-primary-foreground" />
        ))}
    </span>
  );
}

export function AskUserQuestionView({
  block,
  canAnswer,
  onAnswer,
}: {
  block: ContentBlock;
  canAnswer?: boolean;
  onAnswer?: (text: string) => void | Promise<void>;
}) {
  const questions = parseAskUserQuestion(block.input);
  const [tab, setTab] = useState(0);
  const [selections, setSelections] = useState<string[][]>(() => (questions ?? []).map(() => []));
  const [otherOn, setOtherOn] = useState<boolean[]>(() => (questions ?? []).map(() => false));
  const [otherText, setOtherText] = useState<string[]>(() => (questions ?? []).map(() => ""));
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  if (!questions) {
    return (
      <div className="my-1 text-[11px]">
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <MessageCircleQuestion size={12} className="text-info shrink-0" />
          <span className="font-medium text-foreground">AskUserQuestion</span>
        </div>
        <pre className="ml-5 mt-1 px-2 py-1 rounded bg-muted/40 text-[11px] text-muted-foreground whitespace-pre-wrap wrap-break-word font-mono">
          {JSON.stringify(block.input ?? {}, null, 2)}
        </pre>
      </div>
    );
  }

  const interactive = !!canAnswer && !!onAnswer && !submitted && !dismissed;
  const qi = Math.min(tab, questions.length - 1);
  const q = questions[qi];

  const effectivePicks = (i: number): string[] => {
    const base = selections[i] ?? [];
    const ot = (otherOn[i] ?? false) && (otherText[i] ?? "").trim() ? [(otherText[i] ?? "").trim()] : [];
    return [...base, ...ot];
  };
  const answeredCount = questions.filter((_, i) => effectivePicks(i).length > 0).length;
  const allAnswered = answeredCount === questions.length;

  const pickRadio = (i: number, label: string) => {
    setSelections((prev) => prev.map((s, j) => (j === i ? [label] : s)));
    setOtherOn((prev) => prev.map((v, j) => (j === i ? false : v)));
  };
  const toggleCheck = (i: number, label: string) => {
    setSelections((prev) =>
      prev.map((s, j) => (j !== i ? s : s.includes(label) ? s.filter((l) => l !== label) : [...s, label])),
    );
  };
  const pickOther = (i: number, multi: boolean) => {
    setOtherOn((prev) => prev.map((v, j) => (j === i ? true : v)));
    if (!multi) setSelections((prev) => prev.map((s, j) => (j === i ? [] : s)));
  };

  const submit = async () => {
    if (!interactive || !allAnswered || submitting) return;
    const msg = buildAnswerMessage(
      questions,
      questions.map((_, i) => effectivePicks(i)),
    );
    if (!msg.trim()) return;
    setSubmitting(true);
    try {
      await onAnswer!(msg);
      setSubmitted(true);
    } finally {
      setSubmitting(false);
    }
  };

  const otherSelected = otherOn[qi] ?? false;

  return (
    <div className="my-1.5 rounded-lg border border-border bg-card/60 overflow-hidden text-left">
      {}
      <div className="flex items-start gap-2 border-b border-border px-2.5 pt-2">
        <MessageCircleQuestion size={13} className="text-info shrink-0 mt-0.5 mb-2" />
        {questions.length > 1 ? (
          <div className="flex flex-wrap gap-x-3 flex-1 min-w-0">
            {questions.map((qq, i) => {
              const active = i === qi;
              const done = effectivePicks(i).length > 0;
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => setTab(i)}
                  className={cn(
                    "pb-2 -mb-px text-[11.5px] font-medium border-b-2 transition-colors",
                    active
                      ? "text-foreground border-primary"
                      : "text-muted-foreground border-transparent hover:text-foreground",
                  )}
                >
                  {qq.header || `Q${i + 1}`}
                  {done && <Check size={10} className="inline-block ml-0.5 -mt-0.5 text-success" />}
                </button>
              );
            })}
          </div>
        ) : (
          <span className="flex-1 pb-2 text-[11.5px] font-medium text-foreground">
            {q.header || "Question"}
          </span>
        )}
        {interactive && (
          <button
            type="button"
            onClick={() => setDismissed(true)}
            title="Dismiss — don't answer"
            aria-label="Dismiss question"
            className="mb-1.5 shrink-0 text-muted-foreground/70 hover:text-foreground"
          >
            <X size={13} />
          </button>
        )}
      </div>

      {}
      <div className="px-3 py-2.5">
        {q.question && (
          <p className="mb-2 text-[12.5px] font-medium text-foreground leading-snug">{q.question}</p>
        )}
        <div className="space-y-1">
          {q.options.map((opt, oi) => {
            const selected = !otherSelected && (selections[qi] ?? []).includes(opt.label);
            return (
              <button
                key={oi}
                type="button"
                disabled={!interactive}
                onClick={() => (q.multiSelect ? toggleCheck(qi, opt.label) : pickRadio(qi, opt.label))}
                className={cn(
                  "w-full text-left rounded-md border px-2.5 py-1.5 flex items-start gap-2 transition-colors",
                  selected ? "border-primary bg-primary/10" : "border-border/70",
                  interactive ? "hover:border-primary/60 hover:bg-accent/40" : "cursor-default opacity-90",
                )}
              >
                <ChoiceMark selected={selected} multi={q.multiSelect} />
                <span className="flex-1 min-w-0">
                  <span className="block text-[12px] font-medium text-foreground leading-tight">{opt.label}</span>
                  {opt.description && (
                    <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
                      {opt.description}
                    </span>
                  )}
                </span>
              </button>
            );
          })}

          {}
          <div
            className={cn(
              "rounded-md border px-2.5 py-1.5 transition-colors",
              otherSelected ? "border-primary bg-primary/10" : "border-border/70",
            )}
          >
            <button
              type="button"
              disabled={!interactive}
              onClick={() => pickOther(qi, q.multiSelect)}
              className={cn(
                "w-full text-left flex items-center gap-2",
                interactive ? "" : "cursor-default opacity-90",
              )}
            >
              <ChoiceMark selected={otherSelected} multi={q.multiSelect} />
              <span className="text-[12px] font-medium text-foreground">Other…</span>
            </button>
            {interactive && otherSelected && (
              <input
                autoFocus
                value={otherText[qi] ?? ""}
                onChange={(e) =>
                  setOtherText((prev) => prev.map((t, j) => (j === qi ? e.target.value : t)))
                }
                placeholder="Type your answer…"
                className="mt-1.5 w-full rounded-md border border-border bg-background px-2 py-1 text-[12px] text-foreground outline-none focus:border-primary"
              />
            )}
          </div>
        </div>
      </div>

      {}
      <div className="flex items-center gap-2 border-t border-border px-3 py-2">
        {interactive ? (
          <>
            <button
              type="button"
              disabled={!allAnswered || submitting}
              onClick={submit}
              className={cn(
                "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11.5px] font-medium transition-colors",
                allAnswered && !submitting
                  ? "bg-primary text-primary-foreground hover:bg-primary/90"
                  : "bg-secondary text-muted-foreground cursor-not-allowed",
              )}
            >
              {submitting ? "Sending…" : "Submit answers"}
            </button>
            <span className="text-[10.5px] text-muted-foreground">
              {answeredCount}/{questions.length} selected
            </span>
          </>
        ) : (
          <span className="text-[10.5px] italic text-muted-foreground">
            {submitted ? "Answered" : dismissed ? "Dismissed" : "This question is closed — reply in the composer to continue."}
          </span>
        )}
      </div>
    </div>
  );
}

export function ToolUseView({
  block,
  canAnswer,
  onAnswer,
}: {
  block: ContentBlock;
  canAnswer?: boolean;
  onAnswer?: (text: string) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const rawName = block.name ?? "tool";
  if (rawName === "Bash") return <BashToolUseView block={block} />;
  if (rawName === "TodoWrite") return <TodoWriteView block={block} />;
  if (rawName === "Skill") return <SkillToolUseView block={block} />;
  if (rawName === "AskUserQuestion")
    return <AskUserQuestionView block={block} canAnswer={canAnswer} onAnswer={onAnswer} />;
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

const THINKING_VERBS = [
  "Thinking", "Wrangling", "Pondering", "Brewing", "Cooking",
  "Crunching", "Plotting", "Spinning", "Untangling", "Mulling",
];

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
    }, 2400);
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
  const verb = isThinking ? THINKING_VERBS[verbIdx] : (activity.label || "task");
  const icon = isThinking ? (
    <span
      className="inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground/70 animate-pulse"
      aria-hidden="true"
    />
  ) : (
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

export function StreamingAssistantRow({ text }: { text: string }) {
  const cleaned = stripSystemTags(text);
  if (!cleaned.trim()) {
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
  const cleaned = stripSystemTags(text);
  if (!cleaned.trim()) return null;
  return (
    <div className="leading-relaxed">
      <MarkdownText text={cleaned} />
    </div>
  );
}

export function InlineImage({ src }: { src: { mediaType: string; data: string } }) {
  const url = `data:${src.mediaType};base64,${src.data}`;
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
      {}
      <DialogContent className="max-w-[min(92vw,1200px)] p-2 gap-2">
        {}
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
