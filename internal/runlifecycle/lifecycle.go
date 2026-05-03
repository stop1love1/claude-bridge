// Package runlifecycle wires the post-exit "running → done | failed"
// status flip on meta.json runs.
//
// Scope: this is the MINIMAL port of libs/runLifecycle.ts. The TS file
// also drives the verify-chain / inline-verifier / style-critic /
// semantic-verifier gate cascade, the auto-retry decision, speculative
// dispatch winner-selection, and the memory-distill hook. NONE of those
// are ported here — they depend on subsystems (LLM gates, retrySpawn,
// speculative groups) that don't yet have Go counterparts. When they do,
// this package grows; for now the bridge only needs the basic flip so
// the dashboard stops showing children stuck on "running" after exit.
//
// Why no spawn dependency: the input shape is just "a Done channel and
// a way to read the exit code once Done fires." That's exactly what
// spawn.SpawnedSession exposes, but lifting the contract to a function
// + channel keeps tests trivial — they pass a fake exitCode callback
// and close the channel, no exec.Cmd needed.
package runlifecycle

import (
	"context"
	"errors"
	"log"
	"time"

	"github.com/stop1love1/claude-bridge/internal/git"
	"github.com/stop1love1/claude-bridge/internal/meta"
)

// nowISO is overridable in tests; the production clock is time.Now().UTC()
// formatted as RFC3339 with millisecond precision so the JSON timestamps
// match the existing TS writer (`new Date().toISOString()` shape).
var nowISO = func() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z07:00")
}

// AfterSpawnFunc is the signature the post-exit git step uses. Defaults
// to git.AfterSpawn; tests inject a fake to assert the call without
// shelling out to git. Kept on WireOpts (not package-global) so parallel
// tests don't trample each other's hook.
type AfterSpawnFunc func(repoPath, message string, s git.Settings) error

// WireOpts carries the optional plumbing both WireWithOpts and
// WireWithVerifyOpts share. Zero value is a valid "minimal" config: no
// git step, background ctx, no test hook injection. Fields are additive
// — adding a new optional knob here won't break existing callers.
//
// Ctx is the parent (server-shutdown) context. The goroutine drains on
// either the child's done channel closing (the normal path) or ctx.Done
// firing (server stop / caller cancel). Nil ctx is treated as
// context.Background — keeps the zero-value safe for tests.
//
// GitSettings drives the post-exit `git add -A && git commit && git push`
// per the app's bridge.json autoCommit/autoPush flags. CLAUDE.md (Per-app
// git workflow) declares this contract — children must NOT run those git
// commands themselves; the bridge owns them. Until this opt was wired,
// the bridge silently dropped the contract.
//
// CommitMessage is the message git commit -m receives. Empty falls back
// to a generic "bridge: auto-commit after <label>" formed at apply time.
//
// AfterSpawn is the function that actually performs the git step. Nil
// means "use git.AfterSpawn"; tests pass a recording fake.
type WireOpts struct {
	Ctx           context.Context
	GitSettings   *git.Settings
	RepoPath      string
	CommitMessage string
	AfterSpawn    AfterSpawnFunc
}

// Wire spawns a goroutine that waits for done to close, reads the exit
// code via exitCode, and patches the run row in meta.json:
//
//   - exitCode == 0 → status: "done"
//   - exitCode != 0 → status: "failed"
//
// Backward-compat wrapper around WireWithOpts(WireOpts{}). Existing
// callers that don't need post-exit git or shutdown-cancellation keep
// the original signature; new callers pass WireWithOpts directly.
func Wire(sessionsDir, sessionID string, done <-chan struct{}, exitCode func() int, label string) {
	WireWithOpts(sessionsDir, sessionID, done, exitCode, label, WireOpts{})
}

// WireWithOpts is the full-control variant — accepts a context (for
// server-shutdown cancellation) plus the optional post-exit git step
// metadata. See WireOpts for field semantics.
//
// In both clean-exit and crash-exit cases endedAt is stamped to the
// current time. The patch is gated on a precondition that only flips a
// still-running row: a late exit signal must NOT demote a run that the
// /link API (or some future post-exit gate) has already promoted to
// "done". This is the same race-safety the TS version enforces via its
// `(run) => run.status === "running"` precondition, but the meta-side
// helper does the lock + re-read for us.
//
// On clean exit (code 0) and when opts.GitSettings is non-nil with
// AutoCommit or AutoPush set, the goroutine fires the post-exit git
// step. Failures from that step are logged but never demote the run to
// failed — CLAUDE.md (Per-app git workflow) is explicit: "Failures are
// logged but never flip a successful run to failed."
//
// opts.Ctx cancels the goroutine on shutdown so a never-closed done
// channel doesn't leak the goroutine for the lifetime of the process.
// The patch itself is idempotent on cancellation (we simply skip it);
// the caller is expected to pass a server-shutdown context that fires
// only when the bridge is actually stopping.
//
// Failures are logged via the standard `log` package (no zerolog here —
// internal/spawn doesn't pull it in either). label is the prefix used in
// log lines so multi-task operators can tell which run misbehaved; if
// empty, sessionID is used.
//
// The call returns immediately. Callers do not need to track the
// goroutine — it terminates as soon as done closes (or ctx fires) and
// the patch completes.
func WireWithOpts(sessionsDir, sessionID string, done <-chan struct{}, exitCode func() int, label string, opts WireOpts) {
	if label == "" {
		label = sessionID
	}
	ctx := opts.Ctx
	if ctx == nil {
		ctx = context.Background()
	}
	go func() {
		// Outer guard: any panic from patchExit / runAfterSpawn (or any
		// future call we add to this goroutine body) must NOT take the
		// bridge process down. The inner recover around exitCode keeps
		// the run-status flip path; this catch-all is a last-resort
		// safety net that turns a logic bug into a logged warning.
		defer func() {
			if r := recover(); r != nil {
				log.Printf("runlifecycle: %s: goroutine panic: %v", label, r)
			}
		}()
		select {
		case <-done:
		case <-ctx.Done():
			// Server shutdown / caller cancel. The run stays in whatever
			// state meta.json currently has — operators see it as
			// running on next start, the reaper flips it to stale. No
			// patch here keeps shutdown side-effect-free.
			return
		}
		// exitCode may panic if the caller forgot to wait for the
		// process to exit before reading ProcessState; defer-recover
		// keeps a programmer error from crashing the bridge.
		var code int
		func() {
			defer func() {
				if r := recover(); r != nil {
					log.Printf("runlifecycle: exitCode panic for %s: %v", label, r)
					code = -1
				}
			}()
			code = exitCode()
		}()
		patchExit(sessionsDir, sessionID, code, label)
		if code == 0 {
			runAfterSpawn(label, opts)
		}
	}()
}

// runAfterSpawn fires the bridge-managed git step on a clean exit. No-op
// when GitSettings is nil or both flags are off. CLAUDE.md owners: see
// "Per-app git workflow" — this is the half the bridge owes children
// who follow the "don't run git yourself" rule.
func runAfterSpawn(label string, opts WireOpts) {
	if opts.GitSettings == nil {
		return
	}
	if !opts.GitSettings.AutoCommit && !opts.GitSettings.AutoPush {
		return
	}
	if opts.RepoPath == "" {
		log.Printf("runlifecycle: %s: skip post-exit git: empty RepoPath", label)
		return
	}
	hook := opts.AfterSpawn
	if hook == nil {
		hook = git.AfterSpawn
	}
	msg := opts.CommitMessage
	if msg == "" {
		msg = "bridge: auto-commit after " + label
	}
	// Belt-and-suspenders: the git step shells out to `git`, which can
	// panic on truly broken environments (PATH resolution, etc.). Wrap
	// in recover so a panic here can never demote the run.
	defer func() {
		if r := recover(); r != nil {
			log.Printf("runlifecycle: %s: post-exit git panic: %v", label, r)
		}
	}()
	if err := hook(opts.RepoPath, msg, *opts.GitSettings); err != nil {
		log.Printf("runlifecycle: %s: post-exit git failed (run stays done): %v", label, err)
	}
}

func patchExit(sessionsDir, sessionID string, code int, label string) {
	target := meta.RunStatusDone
	if code != 0 {
		target = meta.RunStatusFailed
	}
	endedAt := nowISO()
	_, err := meta.UpdateRun(
		sessionsDir,
		sessionID,
		func(r *meta.Run) {
			r.Status = target
			r.EndedAt = &endedAt
		},
		// Only flip a still-running row. A `done` row already promoted
		// by /link or a future gate must not be demoted to `failed` by
		// a late exit signal — the TS version uses the same guard.
		func(r meta.Run) bool {
			return r.Status == meta.RunStatusRunning
		},
	)
	if err != nil {
		// ErrMissingMeta / ErrRunNotFound are surfaced too — they
		// indicate the task dir was deleted (or the link never landed)
		// while the child was still running. Useful operator signal,
		// not a crash condition.
		if errors.Is(err, meta.ErrMissingMeta) || errors.Is(err, meta.ErrRunNotFound) {
			log.Printf("runlifecycle: %s: cannot patch (%v)", label, err)
			return
		}
		log.Printf("runlifecycle: %s: UpdateRun failed: %v", label, err)
	}
}
