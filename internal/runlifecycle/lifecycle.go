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
	"errors"
	"log"
	"time"

	"github.com/stop1love1/claude-bridge/internal/meta"
)

// nowISO is overridable in tests; the production clock is time.Now().UTC()
// formatted as RFC3339 with millisecond precision so the JSON timestamps
// match the existing TS writer (`new Date().toISOString()` shape).
var nowISO = func() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z07:00")
}

// Wire spawns a goroutine that waits for done to close, reads the exit
// code via exitCode, and patches the run row in meta.json:
//
//   - exitCode == 0 → status: "done"
//   - exitCode != 0 → status: "failed"
//
// In both cases endedAt is stamped to the current time. The patch is
// gated on a precondition that only flips a still-running row: a late
// exit signal must NOT demote a run that the /link API (or some future
// post-exit gate) has already promoted to "done". This is the same
// race-safety the TS version enforces via its `(run) => run.status ===
// "running"` precondition, but the meta-side helper does the lock +
// re-read for us.
//
// Failures are logged via the standard `log` package (no zerolog here —
// internal/spawn doesn't pull it in either). label is the prefix used in
// log lines so multi-task operators can tell which run misbehaved; if
// empty, sessionID is used.
//
// The call returns immediately. Callers do not need to track the
// goroutine — it terminates as soon as done closes and the patch
// completes.
func Wire(sessionsDir, sessionID string, done <-chan struct{}, exitCode func() int, label string) {
	if label == "" {
		label = sessionID
	}
	go func() {
		<-done
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
	}()
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
