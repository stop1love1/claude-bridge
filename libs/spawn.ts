import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { registerChild } from "./spawnRegistry";
import { emitAlive, emitPartial, emitStatus } from "./sessionEvents";
import { BRIDGE_PORT, BRIDGE_URL } from "./paths";
import { getOrCreateInternalToken } from "./auth";
import { withUltracodeDirective } from "./systemPrompt";

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";

export interface ChatSettings {
  mode?: "default" | "acceptEdits" | "plan" | "auto" | "bypassPermissions" | "dontAsk";
  effort?: EffortLevel;
  model?: string;
  disallowedTools?: string[];
}

export type CliEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type EffortLevel = CliEffort | "ultracode";

const VALID_MODES = new Set<NonNullable<ChatSettings["mode"]>>([
  "default", "acceptEdits", "plan", "auto", "bypassPermissions", "dontAsk",
]);
const CLI_EFFORTS = new Set<CliEffort>(["low", "medium", "high", "xhigh", "max"]);

export function resolveEffort(
  e: ChatSettings["effort"],
): { cliEffort?: CliEffort; ultracode: boolean } {
  if (e === "ultracode") return { cliEffort: "xhigh", ultracode: true };
  if (e && CLI_EFFORTS.has(e as CliEffort)) {
    return { cliEffort: e as CliEffort, ultracode: false };
  }
  return { ultracode: false };
}

const TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*(\([^)]*\))?$/;

function settingsArgs(s: ChatSettings | undefined): string[] {
  const args: string[] = [];
  if (!s) return args;
  if (s.mode && VALID_MODES.has(s.mode)) args.push("--permission-mode", s.mode);
  const { cliEffort } = resolveEffort(s.effort);
  if (cliEffort) args.push("--effort", cliEffort);
  if (s.model && /^[a-zA-Z0-9._-]+$/.test(s.model)) args.push("--model", s.model);
  if (Array.isArray(s.disallowedTools) && s.disallowedTools.length > 0) {
    const clean = s.disallowedTools.filter(
      (t) => typeof t === "string" && TOOL_NAME_RE.test(t),
    );
    if (clean.length > 0) args.push("--disallowed-tools", ...clean);
  }
  return args;
}

export function readOnlyChildArgs(): string[] {
  return [
    "--disallowed-tools",
    "Bash",
    "Write",
    "Edit",
    "MultiEdit",
    "NotebookEdit",
    "WebFetch",
    "Task",
  ];
}

function streamingArgs(): string[] {
  return [
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
  ];
}

interface StreamParseState {
  currentMessageId: string | null;
}

function handleStreamLine(
  sessionId: string,
  state: StreamParseState,
  line: string,
): void {
  if (!line || !line.startsWith("{")) return;
  let evt: unknown;
  try {
    evt = JSON.parse(line);
  } catch {
    return;
  }
  if (!evt || typeof evt !== "object") return;
  const e = evt as Record<string, unknown>;

  if (e.type === "system") {
    if (e.subtype === "status" && typeof e.status === "string") {
      if (e.status === "requesting") {
        emitStatus(sessionId, { kind: "thinking" });
      }
      return;
    }
    if (e.subtype === "task_started") {
      const desc = typeof e.description === "string" ? e.description : "";
      const taskType = typeof e.task_type === "string" ? e.task_type : "";
      const label = desc || taskType || "task";
      emitStatus(sessionId, { kind: "running", label });
      return;
    }
    if (e.subtype === "task_notification") {
      emitStatus(sessionId, { kind: "thinking" });
      return;
    }
    return;
  }

  if (e.type !== "stream_event") return;
  const inner = e.event as Record<string, unknown> | undefined;
  if (!inner) return;

  if (inner.type === "message_start") {
    const msg = inner.message as Record<string, unknown> | undefined;
    if (msg && typeof msg.id === "string") state.currentMessageId = msg.id;
    emitStatus(sessionId, { kind: "thinking" });
    return;
  }
  if (inner.type === "message_stop") {
    state.currentMessageId = null;
    return;
  }
  if (inner.type !== "content_block_delta") return;

  const delta = inner.delta as Record<string, unknown> | undefined;
  if (!delta || delta.type !== "text_delta") return;
  const text = typeof delta.text === "string" ? delta.text : "";
  if (!text) return;
  const messageId = state.currentMessageId ?? `live:${sessionId}`;
  const index = typeof inner.index === "number" ? inner.index : 0;
  emitPartial(sessionId, { messageId, index, text });
}

const stderrTails = new WeakMap<ChildProcess, Buffer[]>();
const STDERR_TAIL_MAX_CHUNKS = 32;

function appendStderr(child: ChildProcess, chunk: Buffer) {
  const buf = stderrTails.get(child);
  if (!buf) return;
  buf.push(chunk);
  if (buf.length > STDERR_TAIL_MAX_CHUNKS) buf.shift();
}

function readStderrTail(child: ChildProcess, maxBytes = 2000): string {
  const buf = stderrTails.get(child);
  if (!buf || buf.length === 0) return "";
  const joined = Buffer.concat(buf).toString("utf8");
  return joined.length > maxBytes ? joined.slice(-maxBytes) : joined;
}

export function autoApproveEnv(
  settings: ChatSettings | undefined,
): { BRIDGE_AUTO_APPROVE: string } | Record<string, never> {
  if (settings?.mode === "bypassPermissions") return { BRIDGE_AUTO_APPROVE: "1" };
  return {};
}

function spawnClaudeWithStdin(
  cwd: string,
  args: string[],
  stdinPayload: string,
  sessionId: string,
  settings: ChatSettings | undefined,
): ChildProcess {
  const child = spawn(CLAUDE_BIN, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: (() => {
      const { BRIDGE_AUTO_APPROVE: _drop, ...rest } = process.env;
      void _drop;
      return {
        ...rest,
        BRIDGE_PORT: String(BRIDGE_PORT),
        BRIDGE_URL,
        BRIDGE_INTERNAL_TOKEN: getOrCreateInternalToken(),
        ...autoApproveEnv(settings),
      };
    })(),
    windowsHide: true,
  });
  if (child.stdin) {
    child.stdin.on("error", () => { });
    child.stdin.write(stdinPayload, () => {
      try {
        child.stdin?.end();
      } catch {
      }
    });
  }
  emitAlive(sessionId, true);
  const state: StreamParseState = { currentMessageId: null };
  let buf = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      handleStreamLine(sessionId, state, line);
      nl = buf.indexOf("\n");
    }
  });
  child.stdout?.on("end", () => {
    if (buf.trim()) handleStreamLine(sessionId, state, buf.trim());
    buf = "";
  });
  stderrTails.set(child, []);
  child.stderr?.on("data", (chunk: Buffer) => appendStderr(child, chunk));
  const onTerminate = () => {
    emitAlive(sessionId, false);
    emitStatus(sessionId, { kind: "idle" });
  };
  child.once("exit", onTerminate);
  child.once("error", onTerminate);
  return child;
}

export interface EarlyFailure {
  code: number;
  stderr: string;
}

export function waitEarlyFailure(
  child: ChildProcess,
  windowMs = 1500,
): Promise<EarlyFailure | null> {
  if (child.exitCode !== null) {
    const code = child.exitCode;
    return Promise.resolve(
      code === 0 ? null : { code, stderr: readStderrTail(child) },
    );
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: EarlyFailure | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), windowMs);
    if (typeof timer.unref === "function") timer.unref();
    child.once("exit", (code) => {
      if (code === 0 || code === null) return finish(null);
      finish({ code, stderr: readStderrTail(child) });
    });
    child.once("error", (err) => {
      finish({ code: -1, stderr: String(err) });
    });
  });
}

export interface SpawnOpts {
  role: string;
  taskId: string;
  prompt: string;
  settings?: ChatSettings;
  sessionId?: string;
  settingsPath?: string;
  systemPromptFile?: string;
}

export function buildCoordinatorArgs(opts: SpawnOpts, sessionId: string): string[] {
  return [
    "--session-id", sessionId,
    ...(opts.settingsPath ? ["--settings", opts.settingsPath] : []),
    ...(opts.systemPromptFile
      ? ["--append-system-prompt-file", opts.systemPromptFile]
      : []),
    ...settingsArgs(opts.settings),
    ...streamingArgs(),
    "-p",
  ];
}

export interface SpawnedSession {
  child: ChildProcess;
  sessionId: string;
}

export function spawnClaude(cwd: string, opts: SpawnOpts): SpawnedSession {
  const sessionId = opts.sessionId ?? randomUUID();
  const { ultracode } = resolveEffort(opts.settings?.effort);
  const effectiveOpts: SpawnOpts = ultracode
    ? { ...opts, systemPromptFile: withUltracodeDirective(opts.systemPromptFile, true) }
    : opts;
  const child = spawnClaudeWithStdin(
    cwd,
    buildCoordinatorArgs(effectiveOpts, sessionId),
    opts.prompt,
    sessionId,
    opts.settings,
  );
  registerChild(sessionId, child);
  return { child, sessionId };
}

export function spawnFreeSession(
  cwd: string,
  prompt: string,
  settings?: ChatSettings,
  settingsPath?: string,
  sessionId?: string,
  systemPromptFile?: string,
): SpawnedSession {
  sessionId = sessionId ?? randomUUID();
  systemPromptFile = withUltracodeDirective(
    systemPromptFile,
    resolveEffort(settings?.effort).ultracode,
  );
  const child = spawnClaudeWithStdin(
    cwd,
    [
      "--session-id", sessionId,
      ...(settingsPath ? ["--settings", settingsPath] : []),
      ...(systemPromptFile
        ? ["--append-system-prompt-file", systemPromptFile]
        : []),
      ...settingsArgs(settings),
      ...streamingArgs(),
      "-p",
    ],
    prompt,
    sessionId,
    settings,
  );
  registerChild(sessionId, child);
  return { child, sessionId };
}

export function resumeClaude(
  cwd: string,
  sessionId: string,
  message: string,
  settings?: ChatSettings,
  settingsPath?: string,
): ChildProcess {
  const sysFile = withUltracodeDirective(
    undefined,
    resolveEffort(settings?.effort).ultracode,
  );
  const child = spawnClaudeWithStdin(
    cwd,
    [
      "-p",
      "--resume", sessionId,
      ...(settingsPath ? ["--settings", settingsPath] : []),
      ...(sysFile ? ["--append-system-prompt-file", sysFile] : []),
      ...settingsArgs(settings),
      ...streamingArgs(),
    ],
    message,
    sessionId,
    settings,
  );
  registerChild(sessionId, child);
  return child;
}
