package spawn

import (
	"os/exec"
	"sync"
	"time"
)

// childEntry pairs a running cmd with its stderr-tail handle so the
// kill path can return the captured failure context to the caller.
//
// `exited` is closed by the wait goroutine (via MarkExited) when
// cmd.Wait returns. The kill-escalation goroutine selects on this so a
// child that has already been reaped by Wait can NOT have its (now
// recycled) PID killed by a stray SIGKILL after EscalateAfter — on
// POSIX, sending signal 9 to `-pid` after the kernel reaped that pid
// would target whatever process group inherited the recycled gid.
//
// `waitErr` is the cmd.Wait() error stashed by the wait goroutine so
// downstream consumers (lifecycle hook, /api/runs/:id) can distinguish
// "exited cleanly with non-zero code" from "killed by signal" — the
// former leaves waitErr nil + ExitCode set, the latter leaves both.
type childEntry struct {
	cmd     *exec.Cmd
	tail    *StderrTail
	exited  chan struct{}
	waitErr error
}

// Registry is the in-process map of live claude children, keyed by
// session UUID. Used by the kill endpoint and Phase C tree views to
// answer "is this run actually still alive?" without touching the
// filesystem. NOT persisted — a server restart drops every entry, and
// the stale-run reaper picks up orphaned `running` rows in meta.json.
//
// The TS module stashed the singleton on globalThis to survive Next.js
// HMR; Go has no HMR analogue, so a plain *Registry constructed by the
// surrounding subsystem is enough.
type Registry struct {
	mu       sync.Mutex
	children map[string]*childEntry
	// EscalateAfter is the SIGTERM-to-SIGKILL grace window. Defaults
	// to 3 s; tests override to keep timing assertions fast.
	EscalateAfter time.Duration
}

// NewRegistry returns an empty registry with the production default
// 3-second SIGTERM→SIGKILL grace window.
func NewRegistry() *Registry {
	return &Registry{
		children:      make(map[string]*childEntry),
		EscalateAfter: 3 * time.Second,
	}
}

// Register tracks a child under its session UUID. Safe to call more
// than once — the latest registration wins (we replace the previous
// handle, which would only happen if a session id was reused).
func (r *Registry) Register(sessionID string, cmd *exec.Cmd, tail *StderrTail) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.children[sessionID] = &childEntry{
		cmd:    cmd,
		tail:   tail,
		exited: make(chan struct{}),
	}
}

// MarkExited records cmd.Wait()'s error and closes the per-entry
// `exited` channel. The wait goroutine calls this BEFORE Unregister so
// the kill-escalation goroutine, which selects on `exited`, learns the
// child has been reaped while the entry is still indexed under
// sessionID. waitErr is stored even when nil — callers reading via
// WaitErr() rely on the closed-channel signal to know it's safe to
// read, not on the error itself.
//
// Idempotent: a second MarkExited call (e.g. if Reaper sweeps and the
// wait goroutine both fire) leaves the existing waitErr untouched and
// the close-of-already-closed-channel is guarded by a select. Identity
// check via cmd pointer protects against a re-registered child whose
// predecessor's wait goroutine fires late.
func (r *Registry) MarkExited(sessionID string, cmd *exec.Cmd, waitErr error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	e, ok := r.children[sessionID]
	if !ok || e.cmd != cmd {
		return
	}
	if e.waitErr == nil {
		e.waitErr = waitErr
	}
	select {
	case <-e.exited:
		// already closed — safe no-op.
	default:
		close(e.exited)
	}
}

// WaitErr returns the cmd.Wait() error captured by MarkExited, or
// (nil, false) when the session is unknown / hasn't exited yet. The
// boolean reports whether the entry exists; a nil error with ok=true
// means "exited cleanly per Wait" (the process may still have a
// non-zero exit code — read via cmd.ProcessState.ExitCode()).
func (r *Registry) WaitErr(sessionID string) (error, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	e, ok := r.children[sessionID]
	if !ok {
		return nil, false
	}
	return e.waitErr, true
}

// Get returns the live cmd for a session id, or nil + false when
// nothing's registered.
func (r *Registry) Get(sessionID string) (*exec.Cmd, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	e, ok := r.children[sessionID]
	if !ok {
		return nil, false
	}
	return e.cmd, true
}

// Unregister drops the entry unconditionally. Use UnregisterIf when
// you only want to drop the entry IF the registered cmd is the one
// you're holding — protects against a re-spawn racing a stale exit.
func (r *Registry) Unregister(sessionID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.children, sessionID)
}

// UnregisterIf drops the entry only when the registered cmd matches
// the caller's handle. The wait goroutine in runWithStdin uses this so
// a re-registered child (very rare) doesn't get clobbered when its
// predecessor exits.
func (r *Registry) UnregisterIf(sessionID string, cmd *exec.Cmd) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if e, ok := r.children[sessionID]; ok && e.cmd == cmd {
		delete(r.children, sessionID)
	}
}

// Kill sends SIGTERM (taskkill /T on Windows, killpg on POSIX) to the
// named session, then escalates to SIGKILL after EscalateAfter if the
// child hasn't exited. Returns true when a child was found and a kill
// was sent, false when the session id has no live process.
//
// Idempotent for the false case — a stale UI click doesn't blow up.
//
// The escalation goroutine SELECTS on the per-entry `exited` channel so
// a child that Wait()-reaped before EscalateAfter elapses does NOT get
// its (now potentially recycled) PID hit with SIGKILL. Without this
// guard, on POSIX the kernel could have rebound the PID — and therefore
// the PGID — to an unrelated process by the time the escalation timer
// fired, and `syscall.Kill(-pid, SIGKILL)` would bomb a different
// process group. The map identity check (current.cmd == entry.cmd)
// remains as a second line of defense for the rare case where Unregister
// happens after MarkExited but before the lookup.
func (r *Registry) Kill(sessionID string) bool {
	r.mu.Lock()
	entry, ok := r.children[sessionID]
	r.mu.Unlock()
	if !ok {
		return false
	}
	_ = killProcessTree(entry.cmd, false)
	// Capture the per-entry exited channel under no lock — `exited` is
	// allocated by Register and only ever closed (never reassigned), so
	// reading it after the initial Lock is race-free even if the map
	// entry is later replaced.
	exited := entry.exited
	go func() {
		select {
		case <-time.After(r.EscalateAfter):
		case <-exited:
			// Wait reaped the child; don't risk PID-recycle on the
			// follow-up SIGKILL. Returning here is the whole point of
			// this fix.
			return
		}
		r.mu.Lock()
		current, ok := r.children[sessionID]
		r.mu.Unlock()
		if !ok || current.cmd != entry.cmd {
			return
		}
		_ = killProcessTree(entry.cmd, true)
	}()
	return true
}

// Snapshot returns the set of currently-tracked session IDs. Stable
// alphabetical ordering would require sorting; callers don't need it,
// so we keep the cheap map-iteration order.
func (r *Registry) Snapshot() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]string, 0, len(r.children))
	for sid := range r.children {
		out = append(out, sid)
	}
	return out
}

// Len reports how many children are currently tracked.
func (r *Registry) Len() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.children)
}

// StderrTail returns the StderrTail handle a session was registered
// with. Used by routes (and tests) that need to surface the captured
// failure context to the caller — the kill / message route reaches in
// here rather than the test having to plumb the tail through every
// layer.
func (r *Registry) StderrTail(sessionID string) (*StderrTail, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	e, ok := r.children[sessionID]
	if !ok {
		return nil, false
	}
	return e.tail, true
}
