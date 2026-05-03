package runlifecycle

// Verify-chain runner — partial port of libs/verifyChain.ts.
//
// Scope: only the EXECUTION + CAPTURE half. The TS file also drives the
// retry-spawn / eligibility / context-block rendering for verify-driven
// retries; those depend on the LLM-driven dispatch infrastructure
// (retrySpawn, retryLadder) that does not yet exist on the Go side and
// will be ported in a later session. The runner itself is pure I/O
// (shell-out + byte capture) so it can land first and the caller layer
// can decide later whether to fan results into a retry decision.
//
// Why split the runner from meta.UpdateRun: the TS version writes meta
// from inside `attachGateResult` so it can collapse the status flip and
// the verify field into one patch. The Go side keeps the runner pure —
// the caller (lifecycle.go's Wire hook, or any future post-exit
// orchestrator) owns persistence. That keeps the runner trivially
// testable (no task dir required) and lets the caller pick its own
// race-safety strategy (combined patch, separate patch, no patch).

import (
	"bytes"
	"context"
	"fmt"
	"log"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/stop1love1/claude-bridge/internal/meta"
)

// Canonical step order — matches the `## Verify commands` section in
// childPrompt.ts and the STEP_ORDER constant in libs/verifyChain.ts.
// The runner walks steps in this order regardless of the order the
// caller passed them in, so the recorded step list is stable across
// callers.
var canonicalStepOrder = []string{"format", "lint", "typecheck", "test", "build"}

// Defaults match libs/verifyChain.ts (DEFAULT_TIMEOUT_MS,
// DEFAULT_OUTPUT_CAP_BYTES). Kept exported so callers and tests can
// reference them without re-declaring the magic numbers.
const (
	DefaultVerifyOutputCapBytes = 16 * 1024
	DefaultVerifyStepTimeout    = 5 * time.Minute
)

// VerifyStep is one configured verify command. Name is the canonical
// step label ("format" / "lint" / "typecheck" / "test" / "build"); Cmd
// is the raw shell string (e.g. `bun test --reporter=verbose`).
type VerifyStep struct {
	Name string
	Cmd  string
}

// VerifyOptions tunes execution. Zero values pick sane defaults so the
// common case (`Run(steps, cwd, VerifyOptions{})`) is concise.
//
// ShellOverride lets tests + cross-platform callers swap the shell
// invocation. The default mirrors libs/verifyChain.ts: `sh -c <cmd>` on
// POSIX, `cmd /c <cmd>` on Windows. The TS version uses Node's
// `spawn(..., { shell: true })` which makes the same choice — we encode
// it explicitly because Go's os/exec does not have a "shell: true"
// shortcut.
type VerifyOptions struct {
	OutputCapBytes int
	Timeout        time.Duration
	ShellOverride  string // e.g. "sh -c" or "cmd /c"; empty = platform default
}

// Run executes each step in canonical order via the OS shell, captures
// combined stdout+stderr (capped at OutputCapBytes), and stops on the
// first non-zero exit. Returns a populated meta.RunVerify ready for the
// caller to persist via meta.UpdateRun.
//
// Steps with empty Cmd are silently skipped — same shape as the TS
// `hasAnyVerifyCommand` filter; the runner never emits a verify step
// row for a command the operator left unconfigured.
//
// The error return is reserved for "the runner itself broke" cases that
// don't currently fire — every step capture path is wrapped so a shell
// failure becomes a non-zero exit code on the step row, not a runner
// error. Reserving the slot keeps the signature future-proof if we
// later need to surface "couldn't even start the chain" distinctly from
// "a step failed".
func Run(steps []VerifyStep, cwd string, opts VerifyOptions) (meta.RunVerify, error) {
	cap := opts.OutputCapBytes
	if cap <= 0 {
		cap = DefaultVerifyOutputCapBytes
	}
	timeout := opts.Timeout
	if timeout <= 0 {
		timeout = DefaultVerifyStepTimeout
	}
	shell := opts.ShellOverride
	if shell == "" {
		shell = defaultShell()
	}

	// Index incoming steps by name so we can walk in canonical order.
	// Duplicate names: last write wins (callers shouldn't pass dupes;
	// being lenient here matches the TS map-style lookup).
	byName := make(map[string]string, len(steps))
	for _, s := range steps {
		byName[s.Name] = s.Cmd
	}

	startedAt := nowISO()
	out := meta.RunVerify{
		Steps:     []meta.RunVerifyStep{},
		Passed:    true,
		StartedAt: startedAt,
	}

	for _, name := range canonicalStepOrder {
		raw, ok := byName[name]
		if !ok {
			continue
		}
		trimmed := strings.TrimSpace(raw)
		if trimmed == "" {
			continue
		}
		row := execOne(name, trimmed, cwd, shell, timeout, cap)
		out.Steps = append(out.Steps, row)
		if !row.OK {
			out.Passed = false
			break
		}
	}

	out.EndedAt = nowISO()
	return out, nil
}

// execOne runs a single shell command and returns its captured row.
// Combined stdout+stderr is collected into one buffer (matches the TS
// runner — operators care about ordered output, not stream identity)
// and capped at outputCap bytes with a trailing "(truncated)" note
// when overflow occurs.
//
// Defensive sanity check on the command string mirrors the TS guard:
// NUL / CR / LF in a verify command are virtually always a paste
// accident, and on Windows a stray newline can re-enter cmd.exe parsing
// in surprising ways. We refuse rather than execute.
func execOne(name, cmd, cwd, shell string, timeout time.Duration, outputCap int) meta.RunVerifyStep {
	row := meta.RunVerifyStep{
		Name:     name,
		Cmd:      cmd,
		OK:       false,
		ExitCode: nil,
		Output:   "",
	}
	if strings.ContainsAny(cmd, "\x00\n\r") {
		row.Output = "(bridge: refused to run verify command containing NUL or newline characters)"
		return row
	}

	shellName, shellArgs := splitShell(shell)
	args := append(append([]string{}, shellArgs...), cmd)

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	c := exec.CommandContext(ctx, shellName, args...)
	c.Dir = cwd

	var buf cappedBuffer
	buf.cap = outputCap
	c.Stdout = &buf
	c.Stderr = &buf

	start := time.Now()
	err := c.Run()
	row.DurationMs = time.Since(start).Milliseconds()

	output := buf.String()
	suffix := ""
	if buf.truncated {
		suffix = fmt.Sprintf("\n\n…(bridge: output truncated at %d bytes)", outputCap)
	}

	// Distinguish timeout from generic spawn / non-zero exit. Timeout
	// path leaves ExitCode nil (matches the TS "no code captured —
	// likely timeout / spawn error" branch) and tags the output.
	if ctx.Err() == context.DeadlineExceeded {
		row.Output = output + suffix + nl(output, suffix) +
			fmt.Sprintf("(bridge: aborted after %dms timeout)", timeout.Milliseconds())
		return row
	}

	if err != nil {
		// exec.ExitError carries the real exit code; anything else
		// (PathError, context cancel before start) means we never
		// captured a code — keep ExitCode nil and surface the message.
		var ee *exec.ExitError
		if asExitError(err, &ee) {
			code := ee.ExitCode()
			row.ExitCode = &code
			row.OK = code == 0
			row.Output = output + suffix
			return row
		}
		row.Output = output + suffix + nl(output, suffix) +
			fmt.Sprintf("(bridge: spawn failed — %s)", err.Error())
		return row
	}

	zero := 0
	row.ExitCode = &zero
	row.OK = true
	row.Output = output + suffix
	return row
}

// asExitError is errors.As specialized for *exec.ExitError. Inlined to
// avoid pulling in errors at the top of the file just for this one
// callsite — keeps imports tight.
func asExitError(err error, target **exec.ExitError) bool {
	for cur := err; cur != nil; {
		if e, ok := cur.(*exec.ExitError); ok {
			*target = e
			return true
		}
		// stdlib errors.Unwrap dance without importing the package.
		type unwrapper interface{ Unwrap() error }
		u, ok := cur.(unwrapper)
		if !ok {
			return false
		}
		cur = u.Unwrap()
	}
	return false
}

// nl returns "\n\n" if both pieces are non-empty (so the suffix note
// gets a blank-line gap from the captured output), else "". Tiny
// helper, but inlining it twice in execOne would obscure the intent.
func nl(a, b string) string {
	if a == "" || b == "" {
		return ""
	}
	return "\n\n"
}

// cappedBuffer is an io.Writer that captures up to cap bytes and drops
// the rest, setting truncated=true so the caller can append a marker.
// Avoids unbounded growth on a chatty step (test runners can spew tens
// of MB on failure).
type cappedBuffer struct {
	buf       bytes.Buffer
	cap       int
	truncated bool
}

func (c *cappedBuffer) Write(p []byte) (int, error) {
	if c.truncated {
		// Pretend we wrote everything so the child doesn't get EPIPE'd
		// — we just keep silently dropping. Matches the TS append()
		// short-circuit which also returns silently.
		return len(p), nil
	}
	remaining := c.cap - c.buf.Len()
	if remaining <= 0 {
		c.truncated = true
		return len(p), nil
	}
	if len(p) <= remaining {
		c.buf.Write(p)
		return len(p), nil
	}
	c.buf.Write(p[:remaining])
	c.truncated = true
	return len(p), nil
}

func (c *cappedBuffer) String() string { return c.buf.String() }

// defaultShell returns the per-OS shell invocation. POSIX uses sh -c;
// Windows uses cmd /c. The TS version relies on Node's `shell: true`
// which makes the same choice — we encode it explicitly because Go's
// os/exec does not. Operators wanting bash on Windows (e.g. Git Bash
// for `&&` chains) pass ShellOverride: "bash -c".
func defaultShell() string {
	if runtime.GOOS == "windows" {
		return "cmd /c"
	}
	return "sh -c"
}

// splitShell splits a shell invocation like "sh -c" into ("sh", ["-c"]).
// Naive whitespace split is fine — the only valid forms are 2-token
// ("sh -c", "cmd /c", "bash -c") or 3-token with a wrapper flag
// ("env -u FOO bash -c"). Quoting is not supported because no real
// shell prefix needs it.
func splitShell(s string) (string, []string) {
	parts := strings.Fields(s)
	if len(parts) == 0 {
		// Fall back to the platform default if the operator passed
		// whitespace-only — same effect as not setting it at all.
		return splitShell(defaultShell())
	}
	return parts[0], parts[1:]
}

// VerifyHook is the optional callback Wire fires after the success/
// failure status flip. The hook receives the run's repo (so it can
// look up the configured verify commands) and the run's worktree path
// (preferred cwd) or empty string. Return the populated RunVerify and
// the caller (Wire) persists it via meta.UpdateRun on the same row.
//
// Returning (zero RunVerify, error) signals "skip persistence" — used
// for the no-app / coordinator / retry-run cases where the TS version
// short-circuits before calling runVerifyChain. The hook owns that
// decision because the Go side doesn't yet have an apps registry; the
// caller layer (when it grows one) wires it in.
type VerifyHook func(sessionID, repo string) (meta.RunVerify, bool, error)

// WireWithVerify is the Wire variant that runs a verify hook after the
// status flip lands. Backward-compat wrapper around WireWithVerifyOpts:
// existing callers (no ctx, no autoCommit/autoPush) keep this shape;
// new callers pass WireWithVerifyOpts directly with WireOpts populated.
//
// When hook is nil this behaves identically to Wire (existing callers
// don't have to migrate). When hook is non-nil and the status flip
// succeeded as "done", the hook is invoked; if it returns persist=true
// and no error, the resulting RunVerify is patched onto the run.
func WireWithVerify(sessionsDir, sessionID string, done <-chan struct{}, exitCode func() int, label string, hook VerifyHook) {
	WireWithVerifyOpts(sessionsDir, sessionID, done, exitCode, label, hook, WireOpts{})
}

// WireWithVerifyOpts is the full-control verify-path variant. Accepts
// the same WireOpts as WireWithOpts so the verify path also honors
// the post-exit git step + ctx-cancel.
//
// Hook failures are logged via the standard `log` package and never
// promote a successful run to failed — verify is advisory metadata,
// not a status gate at this layer (the LLM-driven retry cascade that
// would gate on it is out of scope for this port).
//
// Post-exit git step (autoCommit/autoPush per opts.GitSettings) runs
// AFTER the verify hook completes — verify is advisory, not a gate, so
// a verify failure must NOT block the commit. CLAUDE.md owns this
// contract: "Failures are logged but never flip a successful run to
// failed." Same goes for the git step on a verify-fail-but-exit-clean
// run; the operator can revert manually.
//
// opts.Ctx propagates server-shutdown so the goroutine drains cleanly.
// The done channel still wins when both fire — we don't want a
// transient shutdown signal to short-circuit a child that has already
// exited.
func WireWithVerifyOpts(sessionsDir, sessionID string, done <-chan struct{}, exitCode func() int, label string, hook VerifyHook, opts WireOpts) {
	if hook == nil {
		WireWithOpts(sessionsDir, sessionID, done, exitCode, label, opts)
		return
	}
	if label == "" {
		label = sessionID
	}
	ctx := opts.Ctx
	if ctx == nil {
		ctx = context.Background()
	}
	go func() {
		// Outer guard: any panic in patchExit / runVerifyHook /
		// runAfterSpawn must NOT take the bridge process down. The
		// inner recover around exitCode keeps the status-flip path
		// (so a panicking exitCode still ends in "failed"); this
		// catch-all is a last-resort safety net for the rest of the
		// goroutine body.
		defer func() {
			if r := recover(); r != nil {
				log.Printf("runlifecycle: %s: goroutine panic: %v", label, r)
			}
		}()
		select {
		case <-done:
		case <-ctx.Done():
			return
		}
		var code int
		func() {
			defer func() {
				if r := recover(); r != nil {
					code = -1
				}
			}()
			code = exitCode()
		}()
		patchExit(sessionsDir, sessionID, code, label)
		if code != 0 {
			return // verify + git only run on clean exit
		}
		runVerifyHook(sessionsDir, sessionID, label, hook)
		// Post-exit git step is wired here too (not just in Wire) —
		// the verify chain has finished and the run is staying in
		// "done", regardless of verify's verdict. Run the auto-commit/
		// push so the working tree doesn't drift just because the
		// caller opted into verify.
		runAfterSpawn(label, opts)
	}()
}

// runVerifyHook invokes the hook, persists the result, and logs any
// errors. Split out from WireWithVerify so the goroutine body stays
// short and the persistence path is callable from tests directly.
//
// Panic recovery: a buggy hook (or a panic inside Run that wasn't
// caught earlier) must NOT kill the goroutine — the run already
// completed, the status was already flipped to "done", and verify is
// advisory metadata. A panic here means we lose the verify row but
// keep the run; better than a crash that takes down the bridge process.
func runVerifyHook(sessionsDir, sessionID, label string, hook VerifyHook) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("runlifecycle: %s: verify hook panic: %v (run stays done)", label, r)
		}
	}()
	// Read the run's repo so the hook can resolve the verify config.
	// If meta.json is gone (task archived during the run), bail
	// quietly — Wire already logged the missing-meta case.
	m, err := meta.ReadMeta(sessionsDir)
	if err != nil || m == nil {
		return
	}
	var repo string
	for _, r := range m.Runs {
		if r.SessionID == sessionID {
			repo = r.Repo
			break
		}
	}
	if repo == "" {
		return
	}

	result, persist, err := hook(sessionID, repo)
	if err != nil || !persist {
		return
	}
	_, _ = meta.UpdateRun(sessionsDir, sessionID, func(r *meta.Run) {
		v := result
		r.Verify = &v
	}, nil)
}
