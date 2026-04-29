import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { registerChild } from "./spawnRegistry";
import { emitAlive, emitPartial, emitStatus } from "./sessionEvents";
import { BRIDGE_PORT, BRIDGE_URL } from "./paths";
import { getOrCreateInternalToken } from "./auth";

/**
 * `claude` binary path. Defaults to the bare command so the OS resolves
 * it via PATH — same binary `which claude` returns in the operator's
 * shell. `CLAUDE_BIN` overrides this when an explicit path is needed.
 */
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";

/**
 * Per-turn settings the user can dial in from the composer. Only fields
 * the user explicitly set are forwarded — `claude` defaults are otherwise
 * left intact (we never inject `--model` or `--effort` on every call).
 */
export interface ChatSettings {
  mode?: "default" | "acceptEdits" | "plan" | "auto" | "bypassPermissions" | "dontAsk";
  effort?: "low" | "medium" | "high" | "max";
  model?: string;
  /**
   * Tool names to deny via `--disallowed-tools`. Used by the coordinator
   * spawn path to hard-block the built-in `Task` (subagent) tool — the
   * coordinator's only contract for parallel work is the bridge's
   * `/api/tasks/<id>/agents` endpoint, which spawns a real child claude
   * with cwd = the target app's path. The built-in Task tool runs
   * subagents IN-PROCESS sharing the coordinator's cwd (`claude-bridge`),
   * so any work it dispatches lands in the wrong directory and is
   * invisible to `meta.json`. Blocking the tool at the CLI level is the
   * only place that survives a coordinator that has been prompted to
   * "use whatever subagent feature is available".
   */
  disallowedTools?: string[];
}

const VALID_MODES = new Set<NonNullable<ChatSettings["mode"]>>([
  "default", "acceptEdits", "plan", "auto", "bypassPermissions", "dontAsk",
]);
const VALID_EFFORT = new Set<NonNullable<ChatSettings["effort"]>>([
  "low", "medium", "high", "max",
]);
const TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*(\([^)]*\))?$/;

function settingsArgs(s: ChatSettings | undefined): string[] {
  const args: string[] = [];
  if (!s) return args;
  if (s.mode && VALID_MODES.has(s.mode)) args.push("--permission-mode", s.mode);
  if (s.effort && VALID_EFFORT.has(s.effort)) args.push("--effort", s.effort);
  if (s.model && /^[a-zA-Z0-9._-]+$/.test(s.model)) args.push("--model", s.model);
  if (Array.isArray(s.disallowedTools) && s.disallowedTools.length > 0) {
    // claude accepts space-separated tool names after --disallowed-tools
    // (multi-arg <tools...>). Filter to a tight charset so a hostile
    // ChatSettings can't smuggle additional flags through.
    const clean = s.disallowedTools.filter(
      (t) => typeof t === "string" && TOOL_NAME_RE.test(t),
    );
    if (clean.length > 0) args.push("--disallowed-tools", ...clean);
  }
  return args;
}

/**
 * Force claude to emit machine-readable streaming output to stdout.
 *   --output-format stream-json    : one JSON event per line
 *   --verbose                      : required by stream-json
 *   --include-partial-messages     : emit `content_block_delta` chunks
 *                                     so the UI can render token-by-token
 *
 * The .jsonl session persistence layer is unaffected — claude still
 * appends the canonical assistant entries to disk, which the existing
 * tail watcher continues to read.
 */
function streamingArgs(): string[] {
  return [
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
  ];
}

/**
 * Per-spawn state for the stream-json parser. Tracks the current
 * assistant message id (set on `message_start`, cleared on
 * `message_stop`) so we can tag every delta with the right id even
 * though claude only emits the id on `message_start`.
 */
interface StreamParseState {
  /** Claude API message id (msg_…) for the assistant message currently being streamed. */
  currentMessageId: string | null;
}

/**
 * Parse one line of stream-json stdout and forward text deltas to the
 * per-session pub/sub. Silently swallows malformed lines — we never
 * want a parse error to crash the parent process.
 *
 * Two parallel signal streams come out of this:
 *   - text deltas (`stream_event/content_block_delta`) → `partial` events
 *   - activity/status (`system/status` + `system/task_started` +
 *     `system/task_notification`) → `status` events that drive the
 *     "Thinking… / Running …" indicator the UI shows above the composer
 */
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

  // System-level lifecycle: status / task_started / task_notification.
  // We forward the most recent active signal as the UI's status row —
  // task_started wins over plain `status:requesting` because seeing the
  // tool description ("Run bash: git status") is more useful than the
  // generic "Thinking…".
  if (e.type === "system") {
    if (e.subtype === "status" && typeof e.status === "string") {
      // Only "requesting" maps cleanly to "thinking" today; treat any
      // other value as a noop instead of guessing a label for it.
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
      // Tool finished — flip back to "thinking" because the next API
      // call typically follows immediately. The client clears to
      // "idle" only on message_stop / process exit.
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
    // Don't go straight to idle here — Claude's `claude -p --resume`
    // path may still be writing the canonical .jsonl line and
    // post-message system events. The child exit handler in
    // spawnClaudeWithStdin emits the final `idle` via emitAlive(false),
    // and the SSE route maps that to a status reset on the client.
    return;
  }
  if (inner.type !== "content_block_delta") return;

  const delta = inner.delta as Record<string, unknown> | undefined;
  if (!delta || delta.type !== "text_delta") return;
  const text = typeof delta.text === "string" ? delta.text : "";
  if (!text) return;
  // Fall back to a stable per-session sentinel when message_start
  // hasn't been seen yet — keeps the client able to group deltas.
  const messageId = state.currentMessageId ?? `live:${sessionId}`;
  const index = typeof inner.index === "number" ? inner.index : 0;
  emitPartial(sessionId, { messageId, index, text });
}

/**
 * Tail of stderr captured per child, used by `waitEarlyFailure` to
 * surface "binary not found / bad args / instant crash" cases. We keep
 * a per-child buffer instead of a single global so concurrent spawns
 * don't trample each other's failure context.
 */
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

/**
 * Spawn `claude -p` with the prompt fed via stdin.
 *
 * On Windows, passing a multi-line prompt as a CLI arg gets mangled by
 * cmd.exe (newlines act as command separators, brackets / quotes are
 * re-interpreted). Streaming the prompt through stdin sidesteps the
 * shell entirely — `claude -p` reads stdin when no prompt arg is given.
 *
 * stdout carries the stream-json event log: each line is one JSON
 * object. We parse them here and forward `content_block_delta/text_delta`
 * fragments to `sessionEvents`, which the SSE tail/stream route fans
 * out to connected UIs — that's how Claude's reply appears
 * token-by-token instead of arriving as one big block when the .jsonl
 * line lands.
 *
 * `alive` flips true here and false on exit so the Stop button stays
 * pinned to the *real* process state, not the previous "did a tail
 * event arrive in the last 4 seconds" heuristic which dropped during
 * long tool calls / model-thinking gaps.
 *
 * stderr is drained AND tailed so callers can surface failures via
 * `waitEarlyFailure`.
 */
/**
 * Decide whether to set `BRIDGE_AUTO_APPROVE=1` for the child. Only the
 * `bypassPermissions` mode skips the popup — coordinator and auto-spawned
 * children run headless, so a hung permission hook would block the whole
 * task. Every other mode (`default`, `acceptEdits`, `plan`, `auto`,
 * `dontAsk`) leaves the env unset so the hook contacts the bridge and
 * the user sees an Allow/Deny popup.
 *
 * Exported for unit testing — the spawn path itself stitches the result
 * into the child env via spread.
 */
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
    // NOTE: NOT `detached: true`. The bridge wants spawned `claude`
    // children to die when the bridge dies (operator hits Ctrl-C, the
    // dev server reloads, the host VM goes down). With `detached:true`
    // + `unref()` the children survived parent exit and kept consuming
    // the .jsonl files — orphaned, untracked, and a pain to clean up
    // by PID. Leaving children in the bridge's own process group means
    // a SIGTERM to the bridge propagates naturally on POSIX, and on
    // Windows the Job-object the dev server runs in already cleans the
    // tree on parent exit. The kill path uses `treeKill` (taskkill /T
    // on Windows, `kill -GROUP` on POSIX) for explicit Stop-button kills.
    // stdin: pipe so we can write the prompt; stdout/stderr piped + drained.
    stdio: ["pipe", "pipe", "pipe"],
    // Force-propagate BRIDGE_PORT / BRIDGE_URL so the spawned child's
    // permission hook (`agents/permission-hook.cjs`) and any curl-back
    // prompts hit the SAME port the bridge is currently listening on.
    // Without this the hook defaults to 7777 even when the operator
    // started the bridge with PORT=8080, and the Allow/Deny popup never
    // reaches the UI.
    //
    // BRIDGE_AUTO_APPROVE is set only for `bypassPermissions` mode (see
    // `autoApproveEnv`) — every other mode leaves it unset so the hook
    // pops the Allow/Deny dialog in the bridge UI. We DO NOT inherit the
    // operator's BRIDGE_AUTO_APPROVE from process.env: the per-spawn
    // setting is the source of truth, and an inherited "1" would silently
    // override the user's per-task choice.
    env: (() => {
      const { BRIDGE_AUTO_APPROVE: _drop, ...rest } = process.env;
      void _drop;
      // BRIDGE_INTERNAL_TOKEN: lets the child's permission hook + the
      // coordinator template's self-register curl bypass the auth
      // middleware without a browser cookie. Empty string when auth
      // isn't configured yet (the middleware short-circuits in that
      // case anyway, so children don't need to authenticate).
      return {
        ...rest,
        BRIDGE_PORT: String(BRIDGE_PORT),
        BRIDGE_URL,
        BRIDGE_INTERNAL_TOKEN: getOrCreateInternalToken(),
        ...autoApproveEnv(settings),
      };
    })(),
    // shell:true wraps the call in `cmd /c ...` on Windows, which mangles
    // UTF-8 stdin and breaks claude.exe's handshake. CLAUDE_BIN is always
    // an absolute path to a .exe (or `claude` shim on PATH), so spawn
    // can launch it directly without a shell on every platform.
    windowsHide: true,
  });
  if (child.stdin) {
    child.stdin.on("error", () => { /* swallow EPIPE on early child exit */ });
    // Honor backpressure: large prompts (symbol index + pinned files
    // + recent direction can push past the OS pipe buffer) on slow
    // Windows pipes have been observed to truncate when end() runs
    // before the kernel drains. Wait for the write callback so end()
    // only fires after the bytes are actually queued.
    child.stdin.write(stdinPayload, () => {
      try {
        child.stdin?.end();
      } catch {
        /* child may have exited between write and end */
      }
    });
  }
  emitAlive(sessionId, true);
  // Line-buffered stdout JSON parser. stream-json prints one event per
  // line; tcp/pipe buffering can split a logical line across chunks, so
  // we accumulate until each newline boundary.
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
  // Reset the "Thinking…/Running …" indicator alongside alive — the
  // client otherwise keeps pulsing the last known status forever after
  // a kill or crash.
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

/**
 * Wait briefly for an early-exit failure. Resolves to `null` if the
 * child is still alive after `windowMs` (the normal case for a healthy
 * spawn — `claude -p` runs for many seconds), or to `{code, stderr}`
 * when the child exits non-zero / errors within the window.
 *
 * Used by the message route to convert silent spawn failures into a
 * 502 response with the captured stderr tail, instead of returning 200
 * and leaving the user wondering why nothing replied.
 */
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
  /** Free-form role label, chosen by the coordinator (e.g. "coordinator", "coder", "reviewer", "planner"). */
  role: string;
  taskId: string;
  prompt: string;
  settings?: ChatSettings;
  /**
   * Pre-allocated session UUID. If omitted, `spawnClaude` mints one with
   * `randomUUID()`. The bridge passes this in for the coordinator path
   * so the rendered prompt can include the session id literally.
   */
  sessionId?: string;
  /**
   * Optional path to a per-spawn settings JSON file. Forwarded to
   * `claude --settings <path>` so we can register a PreToolUse permission
   * hook on a per-session basis.
   */
  settingsPath?: string;
}

/**
 * Build the flag list for the coordinator spawn. The prompt itself is
 * NOT in the args — it goes via stdin. We used to prepend a
 * `[ROLE: …] [TASK: …]` tag here for session discovery; that's gone now
 * (we pre-generate the session UUID via `--session-id`) and the tag was
 * leaking into the model's context, confusing it.
 */
export function buildCoordinatorArgs(opts: SpawnOpts, sessionId: string): string[] {
  return [
    "--session-id", sessionId,
    ...(opts.settingsPath ? ["--settings", opts.settingsPath] : []),
    ...settingsArgs(opts.settings),
    ...streamingArgs(),
    "-p",
  ];
}

export interface SpawnedSession {
  child: ChildProcess;
  sessionId: string;
}

/**
 * Spawn the coordinator session for a task. Pre-generates the session
 * UUID via `--session-id` so the caller can register the run with
 * meta.json immediately, before claude has even started writing.
 *
 * If `opts.sessionId` is provided, that uuid is reused — this lets the
 * caller render `{{SESSION_ID}}` into the prompt before the spawn so
 * the coordinator knows its own id without having to hunt for the
 * newest .jsonl in the project dir (which is racy when other claude
 * sessions are also active).
 */
export function spawnClaude(cwd: string, opts: SpawnOpts): SpawnedSession {
  const sessionId = opts.sessionId ?? randomUUID();
  const child = spawnClaudeWithStdin(
    cwd,
    buildCoordinatorArgs(opts, sessionId),
    opts.prompt,
    sessionId,
    opts.settings,
  );
  registerChild(sessionId, child);
  return { child, sessionId };
}

/**
 * Spawn a brand-new Claude session that isn't tied to any bridge task.
 * Used for the "New session" action on the /sessions page — the user
 * picks a repo and types an opening prompt, we hand it to `claude` and
 * leave the resulting `.jsonl` for `listSessions` to surface.
 */
export function spawnFreeSession(
  cwd: string,
  prompt: string,
  settings?: ChatSettings,
  settingsPath?: string,
  sessionId?: string,
): SpawnedSession {
  sessionId = sessionId ?? randomUUID();
  const child = spawnClaudeWithStdin(
    cwd,
    [
      "--session-id", sessionId,
      ...(settingsPath ? ["--settings", settingsPath] : []),
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

/**
 * Resume an existing Claude Code session with a new user message. This
 * extends the SAME session's .jsonl — no new session is created. Each
 * call is a one-shot `claude -p --resume <id>` process that continues
 * the conversation, mirroring what happens when the user types another
 * turn in their own `claude` CLI.
 *
 * `settings` are reapplied per turn — claude treats each --resume as a
 * fresh subprocess invocation, so model / effort / permission-mode have
 * to be passed every time the user wants them.
 *
 * Fire-and-forget from the API's perspective — the caller tails the
 * session's .jsonl via /api/sessions/:id/tail to see the reply stream.
 */
export function resumeClaude(
  cwd: string,
  sessionId: string,
  message: string,
  settings?: ChatSettings,
  settingsPath?: string,
): ChildProcess {
  const child = spawnClaudeWithStdin(
    cwd,
    [
      "-p",
      "--resume", sessionId,
      ...(settingsPath ? ["--settings", settingsPath] : []),
      ...settingsArgs(settings),
      ...streamingArgs(),
    ],
    message,
    sessionId,
    settings,
  );
  // Resume re-attaches the same session UUID, so registering by it
  // means the kill endpoint can target the latest one-shot subprocess.
  registerChild(sessionId, child);
  return child;
}
