package spawn

import (
	"os/exec"
	"sync"
	"time"
)

// childEntry pairs a running cmd with its stderr-tail handle so the
// kill path can return the captured failure context to the caller.
type childEntry struct {
	cmd  *exec.Cmd
	tail *StderrTail
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
	r.children[sessionID] = &childEntry{cmd: cmd, tail: tail}
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
func (r *Registry) Kill(sessionID string) bool {
	r.mu.Lock()
	entry, ok := r.children[sessionID]
	r.mu.Unlock()
	if !ok {
		return false
	}
	_ = killProcessTree(entry.cmd, false)
	// Escalate unless the wait goroutine drops the entry first. We
	// re-check the registry rather than the ProcessState to avoid a
	// race between Wait()'s state mutation and the timer fire.
	go func() {
		time.Sleep(r.EscalateAfter)
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
