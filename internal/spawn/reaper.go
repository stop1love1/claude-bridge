package spawn

import (
	"context"
	"errors"
	"os"
	"sync"
	"time"
)

// Reaper periodically scans the registry and drops entries whose
// process has already exited but somehow wasn't cleaned up by the
// wait goroutine. Belt-and-suspenders for the rare case where the
// runWithStdin wait loop misfires (e.g. a panic in the events emitter
// halted the cleanup before UnregisterIf).
//
// The TS staleRunReaper sat on top of meta.json; this reaper sits on
// top of the in-memory registry. The meta-level reaper (which flips
// `running` → `stale` for rows whose registry entry is missing) ports
// alongside internal/meta in S09 — the algorithm is identical and the
// pure ComputeStalePatches helper here is what that wiring will call.
type Reaper struct {
	Registry *Registry
	// Interval between sweeps. Defaults to 30 s when zero.
	Interval time.Duration
}

// Run drives the reaper until ctx is cancelled. Blocks; callers
// typically launch it in a goroutine. The bridge serve command stops
// the reaper alongside the HTTP server during shutdown.
func (rp *Reaper) Run(ctx context.Context) {
	interval := rp.Interval
	if interval == 0 {
		interval = 30 * time.Second
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			rp.SweepOnce()
		}
	}
}

// SweepOnce runs one pass of the reaper synchronously. Drops any
// registry entry whose process is no longer alive. Idempotent.
//
// Race safety: every drop goes through UnregisterIf, which deletes the
// map entry only when the registered cmd pointer matches the one we
// inspected. That cmd-identity check is what protects against a
// re-registered child (same session id, different *exec.Cmd) being
// clobbered by a late reaper sweep — there's no other lock or
// generation counter; the cmd pointer IS the generation token.
func (rp *Reaper) SweepOnce() {
	if rp.Registry == nil {
		return
	}
	for _, sid := range rp.Registry.Snapshot() {
		cmd, ok := rp.Registry.Get(sid)
		if !ok {
			continue
		}
		if cmd == nil || cmd.Process == nil {
			rp.Registry.Unregister(sid)
			continue
		}
		// On POSIX, sending signal 0 to a process tells you whether
		// it exists without affecting it. On Windows, exec.Cmd's
		// ProcessState becomes non-nil after Wait — that's the wait-
		// goroutine's job; we trust the snapshot here and only act
		// when ProcessState is already populated (i.e. wait returned
		// but the cleanup path didn't execute).
		if cmd.ProcessState != nil {
			rp.Registry.UnregisterIf(sid, cmd)
			continue
		}
		if !processAlive(cmd.Process) {
			rp.Registry.UnregisterIf(sid, cmd)
		}
	}
}

// processAlive returns true when the process referenced by p is still
// running. Implemented via signal-0 on POSIX (works for processes the
// caller owns) and by trusting Process.Pid existence on Windows (full
// liveness check would need OpenProcess; the Wait-goroutine path
// covers the common case). When in doubt, returns true to err on the
// side of NOT dropping a live entry.
func processAlive(p *os.Process) bool {
	return processAliveImpl(p)
}

// computeStalePatch is the shape the meta-level reaper will use once
// internal/meta lands in S09. Pure: given a snapshot of (sessionID,
// status, startedAt, isRegistered, metaCreated), return whether the
// row should flip to "stale".
//
// Mirrors libs/staleRunReaper.ts computeStalePatches semantics:
//   - status="running" without a registry entry → stale immediately
//   - status="running" with a registry entry but startedAt older
//     than runningCutoff → stale
//   - status="queued" with metaCreated older than queuedCutoff → stale
//   - everything else → not stale
//
// Exported (uppercase) so the meta package can call it without
// duplicating the rules.
func ComputeStalePatch(in StaleInput) (stale bool, reason string) {
	switch in.Status {
	case "running":
		if !in.HasRegistryEntry {
			return true, "registry-miss"
		}
		if in.StartedAt.IsZero() {
			return true, "no-startedAt"
		}
		if in.StartedAt.Before(in.Now.Add(-in.RunningStaleAfter)) {
			return true, "wall-clock"
		}
		return false, ""
	case "queued":
		if in.MetaCreatedAt.IsZero() {
			return true, "no-metaCreatedAt"
		}
		if in.MetaCreatedAt.Before(in.Now.Add(-in.QueuedStaleAfter)) {
			return true, "queued-too-long"
		}
		return false, ""
	default:
		return false, ""
	}
}

// StaleInput is the per-row state ComputeStalePatch evaluates.
type StaleInput struct {
	Status            string
	StartedAt         time.Time
	HasRegistryEntry  bool
	MetaCreatedAt     time.Time
	Now               time.Time
	RunningStaleAfter time.Duration
	QueuedStaleAfter  time.Duration
}

// DefaultRunningStaleAfter / DefaultQueuedStaleAfter mirror the
// BRIDGE_STALE_RUN_MIN (30 m) / BRIDGE_QUEUED_STALE_MIN (2 m) defaults
// from libs/staleRunReaper.ts. The meta wiring in S09 reads the env
// vars and feeds resulting durations into ComputeStalePatch.
const (
	DefaultRunningStaleAfter = 30 * time.Minute
	DefaultQueuedStaleAfter  = 2 * time.Minute
)

// ErrShutdownDeadlineExceeded is returned by Spawner.Shutdown when one
// or more children survived the SIGKILL grace window. Callers log it
// and proceed — there's no clean recovery path beyond re-issuing the
// kill, which Shutdown already did.
var ErrShutdownDeadlineExceeded = errors.New("shutdown: some children survived SIGKILL grace window")

// Shutdown sends SIGTERM to every tracked child, waits up to wait
// for them to exit, then escalates to SIGKILL on stragglers. Used by
// the bridge serve command's signal handler so a Ctrl-C doesn't
// orphan child claude processes.
//
// Returns the number of children that exited cleanly within the
// window. err is non-nil when stragglers required SIGKILL.
func (s *Spawner) Shutdown(wait time.Duration) (clean int, err error) {
	if s.Registry == nil {
		return 0, nil
	}
	sids := s.Registry.Snapshot()
	if len(sids) == 0 {
		return 0, nil
	}
	// Capture the cmds + grace before signalling so a concurrent exit
	// doesn't race the snapshot.
	cmds := make([]struct {
		sid string
		cmd interface{ Wait() error }
	}, 0, len(sids))
	for _, sid := range sids {
		c, ok := s.Registry.Get(sid)
		if !ok || c == nil || c.Process == nil {
			continue
		}
		_ = killProcessTree(c, false)
		cmds = append(cmds, struct {
			sid string
			cmd interface{ Wait() error }
		}{sid, c})
	}
	deadline := time.Now().Add(wait)
	var wg sync.WaitGroup
	var done sync.Map
	for _, e := range cmds {
		e := e
		wg.Add(1)
		go func() {
			defer wg.Done()
			// Don't double-call Wait — runWithStdin's goroutine owns
			// the canonical Wait. We poll the registry instead: when
			// the entry is gone, the wait goroutine has fired.
			for time.Now().Before(deadline) {
				if _, ok := s.Registry.Get(e.sid); !ok {
					done.Store(e.sid, true)
					return
				}
				time.Sleep(20 * time.Millisecond)
			}
		}()
	}
	wg.Wait()
	// Escalate to SIGKILL on anyone still around.
	survivors := 0
	for _, e := range cmds {
		if _, ok := done.Load(e.sid); ok {
			continue
		}
		c, ok := s.Registry.Get(e.sid)
		if !ok {
			continue
		}
		_ = killProcessTree(c, true)
		survivors++
	}
	if survivors > 0 {
		return len(cmds) - survivors, ErrShutdownDeadlineExceeded
	}
	return len(cmds), nil
}
