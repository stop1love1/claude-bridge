// Package spawn orchestrates child Claude Code processes: spawn,
// stdout/stderr capture into per-session log files, registry tracking,
// graceful shutdown.
//
// Cross-platform process group handling lives in
// process_kill_windows.go (taskkill /F /T) and process_kill_unix.go
// (setpgid at spawn + killpg at terminate) so killing a parent
// reliably reaps grandchildren.
//
// Ported from libs/spawn.ts + libs/spawnRegistry.ts + libs/processKill.ts
// in S07. The stream-json stdout parser (partial / status events) ports
// later — it's only needed once the SSE tail/stream route lands (S12).
// Retry ladder + stale-run reaper + shutdown handler are S08.
package spawn

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"sync"
	"time"

	"github.com/stop1love1/claude-bridge/internal/sessions"
)

// Spawner is the entry point for launching claude subprocesses. Holds
// the binary path, registry handle, and event sink so a single instance
// can serve every spawn route.
//
// Zero value is NOT useful — construct via New().
type Spawner struct {
	// BinaryPath is the absolute path to the claude binary. Defaults
	// to "claude" (resolved via PATH) when New() is used. Tests point
	// it at the fake-claude fixture binary.
	BinaryPath string
	// BridgePort and BridgeURL are forwarded to children via
	// BRIDGE_PORT / BRIDGE_URL env so the permission hook reaches the
	// SAME port the bridge is listening on (TS handler used to default
	// to 7777 even when the operator started on 8080 — same trap here).
	BridgePort int
	BridgeURL  string
	// InternalToken is the bearer the child's permission hook + the
	// coordinator template's self-register curl present to bypass the
	// auth middleware without a browser cookie. Empty string is fine
	// for now — the middleware short-circuits when auth isn't
	// configured (S13/S14 wires the real token).
	InternalToken string
	// LogDir is where per-session stdout is captured to
	// `<sessionID>.log`. Empty disables log capture. Wired by the task
	// route to `sessions/<taskId>/` so the operator can grep for what
	// the child printed without re-reading the .jsonl. The real
	// transcript still lives where claude wrote it
	// (~/.claude/projects/<slug>/<sessionID>.jsonl); this log is the
	// raw stdout stream the bridge observed.
	LogDir string
	// Registry tracks live children so the kill endpoint can find them.
	Registry *Registry
	// Events is the per-session pub/sub for alive / partial / status
	// notifications. Optional in S07 — when nil, lifecycle goroutines
	// skip the emit calls.
	Events *sessions.EventsRegistry
}

// New returns a Spawner with sensible defaults: claude on PATH, no
// internal token, the package-global session-events registry, and a
// fresh process registry. Callers typically override BinaryPath /
// LogDir / Events to suit the surrounding subsystem.
func New() *Spawner {
	return &Spawner{
		BinaryPath: "claude",
		Registry:   NewRegistry(),
		Events:     sessions.Events,
	}
}

// ChatSettings is the subset of per-turn knobs the user can dial in
// from the composer. Only fields the user explicitly set are forwarded
// to claude — defaults are otherwise left intact (we never inject
// --model or --effort on every call).
type ChatSettings struct {
	// Mode is the permission gate; one of default | acceptEdits |
	// plan | auto | bypassPermissions | dontAsk. Empty = leave unset
	// (claude defaults to default).
	Mode string
	// Effort is the reasoning budget hint; one of low | medium | high | max.
	Effort string
	// Model is the model id (e.g. claude-opus-4-7). Charset gated to
	// [A-Za-z0-9._-] so a hostile body can't smuggle additional flags.
	Model string
	// DisallowedTools lists tool names to deny via --disallowed-tools.
	// Used by the coordinator spawn path to hard-block the in-process
	// Task / Agent tool — the only sanctioned dispatch path is the
	// bridge's /api/tasks/<id>/agents endpoint, which spawns a real
	// child claude with cwd = the target app's path.
	DisallowedTools []string
}

var (
	validMode = map[string]struct{}{
		"default": {}, "acceptEdits": {}, "plan": {},
		"auto": {}, "bypassPermissions": {}, "dontAsk": {},
	}
	validEffort = map[string]struct{}{
		"low": {}, "medium": {}, "high": {}, "max": {},
	}
	modelRE    = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)
	toolNameRE = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]*(\([^)]*\))?$`)
)

func settingsArgs(s *ChatSettings) []string {
	if s == nil {
		return nil
	}
	var args []string
	if _, ok := validMode[s.Mode]; ok && s.Mode != "" {
		args = append(args, "--permission-mode", s.Mode)
	}
	if _, ok := validEffort[s.Effort]; ok && s.Effort != "" {
		args = append(args, "--effort", s.Effort)
	}
	if s.Model != "" && modelRE.MatchString(s.Model) {
		args = append(args, "--model", s.Model)
	}
	if len(s.DisallowedTools) > 0 {
		clean := s.DisallowedTools[:0]
		for _, t := range s.DisallowedTools {
			if toolNameRE.MatchString(t) {
				clean = append(clean, t)
			}
		}
		if len(clean) > 0 {
			args = append(args, "--disallowed-tools")
			args = append(args, clean...)
		}
	}
	return args
}

// streamingArgs forces claude to emit machine-readable streaming output
// to stdout: --output-format stream-json + --verbose +
// --include-partial-messages. The .jsonl session persistence layer is
// unaffected — claude still appends canonical assistant entries to disk.
func streamingArgs() []string {
	return []string{
		"--output-format", "stream-json",
		"--verbose",
		"--include-partial-messages",
	}
}

// SpawnOpts is the per-spawn payload for SpawnClaude.
type SpawnOpts struct {
	// Role is the free-form label the coordinator chose
	// (e.g. "coordinator", "coder", "reviewer", "planner").
	Role string
	// TaskID is the bridge task id this run belongs to.
	TaskID string
	// Prompt is the input fed via stdin (NOT a CLI arg — keeps cmd.exe
	// from mangling multi-line prompts).
	Prompt string
	// Settings are the per-turn knobs from the composer; nil = defaults.
	Settings *ChatSettings
	// SessionID may be pre-allocated; if empty, SpawnClaude mints a
	// fresh UUID. Pre-allocating lets the caller render {{SESSION_ID}}
	// into the prompt before the spawn so the coordinator knows its own
	// id without racing the .jsonl writer.
	SessionID string
	// SettingsPath is an optional per-spawn settings JSON file
	// forwarded to claude --settings <path> (registers a PreToolUse
	// permission hook on a per-session basis).
	SettingsPath string
}

// SpawnedSession is the handle returned by SpawnClaude / SpawnFree-
// Session / ResumeClaude.
type SpawnedSession struct {
	Cmd       *exec.Cmd
	SessionID string
	// Done closes when the child has exited. Useful in tests that need
	// to wait for completion without polling cmd.ProcessState.
	Done <-chan struct{}
	// LogPath is the absolute path to the captured stdout log, or empty
	// when LogDir was unset.
	LogPath string
}

// buildCoordinatorArgs assembles the flag list for the coordinator
// spawn. The prompt itself is NOT in the args — it goes via stdin.
func buildCoordinatorArgs(opts SpawnOpts, sessionID string) []string {
	args := []string{"--session-id", sessionID}
	if opts.SettingsPath != "" {
		args = append(args, "--settings", opts.SettingsPath)
	}
	args = append(args, settingsArgs(opts.Settings)...)
	args = append(args, streamingArgs()...)
	args = append(args, "-p")
	return args
}

// SpawnClaude launches the coordinator session for a task. Pre-
// generates the session UUID via --session-id so the caller can
// register the run with meta.json immediately, before claude has even
// started writing.
//
// If opts.SessionID is provided, that uuid is reused.
func (s *Spawner) SpawnClaude(cwd string, opts SpawnOpts) (*SpawnedSession, error) {
	sid := opts.SessionID
	if sid == "" {
		sid = newUUID()
	}
	return s.runWithStdin(cwd, buildCoordinatorArgs(opts, sid), opts.Prompt, sid, opts.Settings)
}

// SpawnFreeSession launches a brand-new claude session not tied to any
// bridge task. Used for the "New session" action on the /sessions page.
func (s *Spawner) SpawnFreeSession(cwd, prompt string, settings *ChatSettings, settingsPath, sessionID string) (*SpawnedSession, error) {
	if sessionID == "" {
		sessionID = newUUID()
	}
	args := []string{"--session-id", sessionID}
	if settingsPath != "" {
		args = append(args, "--settings", settingsPath)
	}
	args = append(args, settingsArgs(settings)...)
	args = append(args, streamingArgs()...)
	args = append(args, "-p")
	return s.runWithStdin(cwd, args, prompt, sessionID, settings)
}

// ResumeClaude extends an existing session with a new user message.
// Each call is a one-shot `claude -p --resume <id>` that continues the
// conversation, mirroring what happens when the user types another
// turn in their own claude CLI.
func (s *Spawner) ResumeClaude(cwd, sessionID, message string, settings *ChatSettings, settingsPath string) (*SpawnedSession, error) {
	args := []string{"-p", "--resume", sessionID}
	if settingsPath != "" {
		args = append(args, "--settings", settingsPath)
	}
	args = append(args, settingsArgs(settings)...)
	args = append(args, streamingArgs()...)
	return s.runWithStdin(cwd, args, message, sessionID, settings)
}

// AutoApproveEnv returns the env entry for BRIDGE_AUTO_APPROVE. Only
// the bypassPermissions mode skips the popup — coordinator and auto-
// spawned children run headless, so a hung permission hook would block
// the whole task. Every other mode leaves the env unset.
//
// Exported for unit testing — the spawn path itself stitches the result
// into the child env.
func AutoApproveEnv(s *ChatSettings) []string {
	if s != nil && s.Mode == "bypassPermissions" {
		return []string{"BRIDGE_AUTO_APPROVE=1"}
	}
	return nil
}

// runWithStdin is the shared body of SpawnClaude / SpawnFreeSession /
// ResumeClaude. Builds the env, opens the log file, wires stdin/stdout/
// stderr, sets the process-group attribute (POSIX only), starts the
// process, registers it with the spawn registry, and kicks off a
// goroutine that waits for exit + emits the alive=false event.
func (s *Spawner) runWithStdin(cwd string, args []string, stdin, sessionID string, settings *ChatSettings) (*SpawnedSession, error) {
	binary := s.BinaryPath
	if binary == "" {
		binary = "claude"
	}
	cmd := exec.Command(binary, args...)
	cmd.Dir = cwd
	cmd.Env = s.childEnv(settings)
	configureProcAttr(cmd)
	cmd.Stdin = newStdinReader(stdin)

	// Per-session log path. Empty LogDir disables capture — stdout is
	// then drained-but-discarded so the child's pipe doesn't block.
	var logPath string
	var stdoutWriter io.Writer = io.Discard
	var logFile *os.File
	if s.LogDir != "" {
		if err := os.MkdirAll(s.LogDir, 0o755); err != nil {
			return nil, fmt.Errorf("spawn: mkdir log dir: %w", err)
		}
		logPath = filepath.Join(s.LogDir, sessionID+".log")
		f, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
		if err != nil {
			return nil, fmt.Errorf("spawn: open log: %w", err)
		}
		logFile = f
		stdoutWriter = f
	}
	cmd.Stdout = stdoutWriter

	tail := newStderrTail()
	cmd.Stderr = tail

	if err := cmd.Start(); err != nil {
		if logFile != nil {
			_ = logFile.Close()
		}
		return nil, fmt.Errorf("spawn: start %s: %w", binary, err)
	}

	if s.Registry != nil {
		s.Registry.Register(sessionID, cmd, tail)
	}
	if s.Events != nil {
		s.Events.EmitAlive(sessionID, true)
	}

	done := make(chan struct{})
	go func() {
		// `done` is the public "child has exited" signal that
		// SpawnedSession.Done returns to callers. It MUST close even if
		// EmitAlive / EmitStatus / log close panic, otherwise Shutdown
		// polls forever and runlifecycle.Wire never patches the run row.
		// The unregister + log close are also deferred so a mid-cleanup
		// panic still releases the registry slot and the file handle —
		// without that, a recycled session id couldn't re-register, and
		// the OS file table would leak one descriptor per panicked run.
		//
		// MarkExited is called BEFORE UnregisterIf so the per-entry done
		// channel (the kill-escalation goroutine selects on it to avoid
		// a PID-recycle race) closes while the entry is still indexed.
		// Closing after Unregister would let an escalation already past
		// the lookup miss the cancellation.
		var waitErr error
		defer close(done)
		defer func() {
			if r := recover(); r != nil {
				log.Printf("spawn: wait goroutine panic for %s: %v", sessionID, r)
			}
		}()
		defer func() {
			if logFile != nil {
				_ = logFile.Close()
			}
		}()
		defer func() {
			if s.Registry != nil {
				s.Registry.MarkExited(sessionID, cmd, waitErr)
				s.Registry.UnregisterIf(sessionID, cmd)
			}
		}()

		waitErr = cmd.Wait()
		if s.Events != nil {
			s.Events.EmitAlive(sessionID, false)
			s.Events.EmitStatus(sessionID, sessions.StatusEvent{Kind: "idle"})
		}
	}()

	return &SpawnedSession{
		Cmd:       cmd,
		SessionID: sessionID,
		Done:      done,
		LogPath:   logPath,
	}, nil
}

func (s *Spawner) childEnv(settings *ChatSettings) []string {
	env := os.Environ()
	// Drop any inherited BRIDGE_AUTO_APPROVE — the per-spawn setting is
	// the source of truth, and an inherited "1" would silently override
	// the user's per-task choice.
	out := env[:0]
	for _, kv := range env {
		if hasPrefix(kv, "BRIDGE_AUTO_APPROVE=") {
			continue
		}
		out = append(out, kv)
	}
	if s.BridgePort > 0 {
		out = append(out, "BRIDGE_PORT="+strconv.Itoa(s.BridgePort))
	}
	if s.BridgeURL != "" {
		out = append(out, "BRIDGE_URL="+s.BridgeURL)
	}
	if s.InternalToken != "" {
		out = append(out, "BRIDGE_INTERNAL_TOKEN="+s.InternalToken)
	}
	out = append(out, AutoApproveEnv(settings)...)
	return out
}

func hasPrefix(s, prefix string) bool {
	return len(s) >= len(prefix) && s[:len(prefix)] == prefix
}

// newStdinReader returns an io.Reader that yields the prompt bytes and
// EOFs. Using strings.Reader-style indirection (rather than a goroutine
// that writes + closes) keeps the lifecycle simple: exec closes stdin
// on its own when the reader returns io.EOF.
func newStdinReader(payload string) io.Reader {
	if payload == "" {
		return nil
	}
	return &stdinReader{payload: payload}
}

type stdinReader struct {
	payload string
	pos     int
}

func (r *stdinReader) Read(p []byte) (int, error) {
	if r.pos >= len(r.payload) {
		return 0, io.EOF
	}
	n := copy(p, r.payload[r.pos:])
	r.pos += n
	return n, nil
}

// EarlyFailure carries the exit code and stderr tail captured when a
// spawn dies inside the early-failure window.
type EarlyFailure struct {
	Code   int
	Stderr string
}

// WaitEarlyFailure waits up to window for the child to exit. Returns
// nil if the child is still running (the normal healthy case), or a
// non-nil failure when the child exits non-zero / can't start within
// the window.
//
// Used by the message route to convert silent spawn failures into a
// 502 with the captured stderr tail, instead of returning 200 and
// leaving the user wondering why nothing replied.
func WaitEarlyFailure(sess *SpawnedSession, tail *StderrTail, window time.Duration) *EarlyFailure {
	select {
	case <-sess.Done:
		ps := sess.Cmd.ProcessState
		if ps == nil {
			// Process never started — Done closed without ProcessState
			// being set. That's effectively an exec error; surface
			// whatever stderr captured.
			return &EarlyFailure{Code: -1, Stderr: tail.Read(2000)}
		}
		code := ps.ExitCode()
		if code == 0 {
			return nil
		}
		return &EarlyFailure{Code: code, Stderr: tail.Read(2000)}
	case <-time.After(window):
		return nil
	}
}

// newUUID returns a v4-style UUID without pulling in google/uuid (which
// is already a transitive dep but explicit imports keep the surface
// honest). Format mirrors what claude expects on --session-id.
func newUUID() string {
	var b [16]byte
	if _, err := io.ReadFull(rand.Reader, b[:]); err != nil {
		// crypto/rand should never fail on supported platforms; fall
		// back to a deterministic time-prefixed id rather than panic.
		return fmt.Sprintf("00000000-0000-4000-8000-%012x", time.Now().UnixNano())
	}
	b[6] = (b[6] & 0x0f) | 0x40 // v4
	b[8] = (b[8] & 0x3f) | 0x80 // RFC 4122
	dst := make([]byte, 36)
	hex.Encode(dst[0:8], b[0:4])
	dst[8] = '-'
	hex.Encode(dst[9:13], b[4:6])
	dst[13] = '-'
	hex.Encode(dst[14:18], b[6:8])
	dst[18] = '-'
	hex.Encode(dst[19:23], b[8:10])
	dst[23] = '-'
	hex.Encode(dst[24:36], b[10:16])
	return string(dst)
}

// StderrTail bounds the stderr capture so a runaway child can't pin
// the bridge with a multi-MB error stream. Concurrency-safe — the
// goroutine draining stderr writes; readers (WaitEarlyFailure, the
// kill route) read.
type StderrTail struct {
	mu     sync.Mutex
	chunks [][]byte
	max    int
}

const stderrTailMaxChunks = 32

func newStderrTail() *StderrTail {
	return &StderrTail{max: stderrTailMaxChunks}
}

// Write satisfies io.Writer; appends one chunk and evicts the oldest
// when over the cap.
func (t *StderrTail) Write(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	chunk := append([]byte(nil), p...)
	t.mu.Lock()
	t.chunks = append(t.chunks, chunk)
	if len(t.chunks) > t.max {
		t.chunks = t.chunks[len(t.chunks)-t.max:]
	}
	t.mu.Unlock()
	return len(p), nil
}

// Read returns the captured tail truncated to maxBytes (most recent
// bytes win). Empty when nothing was captured.
func (t *StderrTail) Read(maxBytes int) string {
	t.mu.Lock()
	defer t.mu.Unlock()
	if len(t.chunks) == 0 {
		return ""
	}
	total := 0
	for _, c := range t.chunks {
		total += len(c)
	}
	out := make([]byte, 0, total)
	for _, c := range t.chunks {
		out = append(out, c...)
	}
	if maxBytes > 0 && len(out) > maxBytes {
		out = out[len(out)-maxBytes:]
	}
	return string(out)
}

// ErrAlreadyExited is returned by Registry.Kill when the named session
// has no live child registered (already exited or never started).
var ErrAlreadyExited = errors.New("session not registered")
