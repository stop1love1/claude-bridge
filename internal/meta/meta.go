// Package meta is the source of truth for per-task runtime state on
// disk: sessions/<task-id>/meta.json. Provides atomic write
// (tempfile + rename) with a per-directory mutex so concurrent
// AppendRun / UpdateRun callers serialize cleanly.
//
// Ported from libs/atomicWrite.ts + libs/tasks.ts + libs/meta.ts in S09.
// Event subscription (SubscribeMeta / SubscribeMetaAll) lives here too
// so the SSE route in S12 can subscribe without depending on the
// per-route singleton stash the TS module used.
package meta

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// RunStatus is the lifecycle state of one spawned claude session.
// Mirrors the TS string union: queued | running | done | failed | stale.
type RunStatus string

const (
	RunStatusQueued  RunStatus = "queued"
	RunStatusRunning RunStatus = "running"
	RunStatusDone    RunStatus = "done"
	RunStatusFailed  RunStatus = "failed"
	RunStatusStale   RunStatus = "stale"
)

// Run is one Claude Code session the coordinator spawned for a task.
// Field naming follows libs/meta.ts exactly so meta.json is bytewise
// interchangeable between the Next reader and the Go reader.
//
// Pointer-typed optional fields (e.g. ParentSessionID *string) keep
// json.Marshal emitting `null` rather than `""` when the field is
// absent — the TS code uses `null` for "explicitly absent" and the
// `omitempty` tag would lose that distinction.
//
// Verifier sub-types (Verify, Verifier, StyleCritic, SemanticVerifier)
// are kept as full Go structs even though S09's surface area doesn't
// touch them — preserving them as `json.RawMessage` would lose the
// shape contract and any future Go-side reader would have to re-derive
// it. The structs are declared in subtypes.go.
type Run struct {
	SessionID string    `json:"sessionId"`
	Role      string    `json:"role"`
	Repo      string    `json:"repo"`
	Status    RunStatus `json:"status"`
	StartedAt *string   `json:"startedAt"`
	EndedAt   *string   `json:"endedAt"`

	ParentSessionID *string `json:"parentSessionId,omitempty"`
	RetryOf         *string `json:"retryOf,omitempty"`
	RetryAttempt    *int    `json:"retryAttempt,omitempty"`

	Verify           *RunVerify           `json:"verify,omitempty"`
	Verifier         *RunVerifier         `json:"verifier,omitempty"`
	StyleCritic      *RunStyleCritic      `json:"styleCritic,omitempty"`
	SemanticVerifier *RunSemanticVerifier `json:"semanticVerifier,omitempty"`

	WorktreePath       *string `json:"worktreePath,omitempty"`
	WorktreeBranch     *string `json:"worktreeBranch,omitempty"`
	WorktreeBaseBranch *string `json:"worktreeBaseBranch,omitempty"`

	SpeculativeGroup   *string `json:"speculativeGroup,omitempty"`
	SpeculativeOutcome *string `json:"speculativeOutcome,omitempty"`
}

// Meta is the per-task runtime state. The full task definition (title,
// body, status, section, checked) lives here too — meta.json is the
// source of truth, replacing the old tasks.md round-trip.
//
// DetectedScope is held as json.RawMessage because its shape lives in
// the detect package (S16). meta.go round-trips the bytes verbatim so
// the eventual detect port doesn't need a coordinated cutover.
type Meta struct {
	TaskID        string          `json:"taskId"`
	TaskTitle     string          `json:"taskTitle"`
	TaskBody      string          `json:"taskBody"`
	TaskStatus    TaskStatus      `json:"taskStatus"`
	TaskSection   TaskSection     `json:"taskSection"`
	TaskChecked   bool            `json:"taskChecked"`
	TaskApp       *string         `json:"taskApp,omitempty"`
	CreatedAt     string          `json:"createdAt"`
	Runs          []Run           `json:"runs"`
	DetectedScope json.RawMessage `json:"detectedScope,omitempty"`
}

// MetaFile is the file basename inside each task's sessions dir.
const MetaFile = "meta.json"

// ErrMissingMeta is returned by AppendRun / UpdateRun when meta.json
// doesn't exist for the task dir. Distinct sentinel so callers can
// surface a 404 instead of a generic 500.
var ErrMissingMeta = errors.New("meta: meta.json missing")

// ErrRunNotFound is returned by UpdateRun when the named sessionID
// doesn't exist in meta.runs.
var ErrRunNotFound = errors.New("meta: run not found")

// ErrMetaExists is returned by CreateMeta when meta.json already
// exists in the target dir. Distinct from a generic write error so
// the API layer can return 409 Conflict instead of 500. Mirrors the
// "create-or-fail" semantics of POST /api/tasks where a duplicate
// task id must NOT clobber the existing meta.
var ErrMetaExists = errors.New("meta: meta.json already exists")

// ReadMeta loads meta.json from the task's sessions dir.
//
// Return values:
//   - (nil, nil) — meta.json doesn't exist (task missing / not yet
//     created). Callers map this to a 404.
//   - (nil, err) — read failure OR JSON parse failure. Parse errors
//     are surfaced rather than swallowed: a truncated file (operator
//     hand-edit, disk corruption, partial restore) signals fixable
//     damage and silently returning (nil, nil) made the dashboard
//     show "task missing" instead of telling the operator their
//     meta.json is broken. The parse failure is not cached.
//   - (m, nil) — happy path.
//
// Cached in-process via the package-global metaCache (TTL 500ms +
// 1024-entry LRU); cache invalidation happens on every emit() — so
// readers immediately see a writeMeta from another goroutine.
func ReadMeta(dir string) (*Meta, error) {
	if hit, ok := metaCache.get(dir); ok {
		return hit, nil
	}
	p := filepath.Join(dir, MetaFile)
	b, err := os.ReadFile(p)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			metaCache.put(dir, nil)
			return nil, nil
		}
		return nil, fmt.Errorf("read %s: %w", p, err)
	}
	var m Meta
	if err := json.Unmarshal(b, &m); err != nil {
		// Don't poison the cache with the parse failure: next read after
		// a writeMeta will pick up the fresh bytes. Surface the error so
		// the operator/UI sees "meta.json corrupt" rather than the
		// misleading "task not found".
		return nil, fmt.Errorf("meta.json parse %s: %w", p, err)
	}
	metaCache.put(dir, &m)
	return &m, nil
}

// CreateMeta initializes a fresh meta.json. Caller passes the header
// fields; if Runs is nil it's initialized to an empty slice (the wire
// shape is `[]`, never `null`). A caller-provided non-nil Runs slice
// is preserved verbatim — useful for tests / restores that want to
// seed historical run rows in the same write.
//
// CreateMeta is "create-or-fail": if meta.json already exists in dir,
// returns ErrMetaExists rather than overwriting. Both the existence
// check and the write happen under the per-task lock, so two
// concurrent CreateMeta calls produce one success + one ErrMetaExists.
//
// Emits writeMeta on the package-global event bus so subscribers
// (S12 SSE route) see the create.
//
// Mirrors libs/meta.ts createMeta.
func CreateMeta(dir string, header Meta) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	if header.Runs == nil {
		header.Runs = []Run{}
	}
	return WithTaskLock(dir, func() error {
		p := filepath.Join(dir, MetaFile)
		if _, err := os.Stat(p); err == nil {
			return ErrMetaExists
		} else if !errors.Is(err, fs.ErrNotExist) {
			return fmt.Errorf("stat %s: %w", p, err)
		}
		return WriteMetaUnlocked(dir, &header)
	})
}

// WriteMeta replaces meta.json on disk and notifies subscribers.
// Acquires the per-task lock, so callers MUST NOT already hold it
// (call WriteMetaUnlocked from inside WithTaskLock instead — or use
// MutateMeta for the read-modify-write pattern).
//
// Mirrors libs/meta.ts writeMeta — emits a writeMeta event (no per-run
// signal — task header changed).
func WriteMeta(dir string, m *Meta) error {
	return WithTaskLock(dir, func() error {
		return WriteMetaUnlocked(dir, m)
	})
}

// WriteMetaUnlocked is the lock-less worker for callers that already
// hold the per-task lock (AppendRun, UpdateRun,
// RemoveSessionFromTask, MutateMeta, the existence-checked tail of
// CreateMeta, and external API handlers that need to perform other
// operations under the same lock alongside the write). Writes the
// JSON, then emits the generic writeMeta event. Helpers that need a
// more specific event kind (spawned/transition/updated) should call
// WriteJSONAtomic + emit directly.
//
// Prefer MutateMeta for the read-modify-write pattern. WriteMeta auto-
// locks for the common case. Use WriteMetaUnlocked only when the
// caller already holds the lock via WithTaskLock.
func WriteMetaUnlocked(dir string, m *Meta) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	if err := WriteJSONAtomic(filepath.Join(dir, MetaFile), m, nil); err != nil {
		return err
	}
	emit(dir, MetaChangeEvent{
		TaskID: taskIDFromDir(dir),
		Kind:   MetaChangeWriteMeta,
	})
	return nil
}

// MutateMeta runs fn(meta) under the per-task lock and writes the
// result back. fn receives the live *Meta loaded from disk; it may
// mutate fields in place. Returning a non-nil error from fn aborts
// the write and propagates up; returning nil triggers a write +
// writeMeta event.
//
// Sentinel returns:
//   - ErrMissingMeta — meta.json doesn't exist (mirrors AppendRun /
//     UpdateRun semantics so callers can branch on the same value).
//
// Group F's API handlers should prefer MutateMeta over the manual
// "WithTaskLock(dir, ReadMeta + WriteMeta)" sequence — it cuts the
// lock-acquisition boilerplate and centralises the missing-meta
// check.
func MutateMeta(dir string, fn func(*Meta) error) error {
	return WithTaskLock(dir, func() error {
		m, err := ReadMeta(dir)
		if err != nil {
			return err
		}
		if m == nil {
			return ErrMissingMeta
		}
		if err := fn(m); err != nil {
			return err
		}
		return WriteMetaUnlocked(dir, m)
	})
}

// AppendRun adds a Run to the task under the per-dir lock and emits a
// "spawned" event. Mirrors libs/meta.ts appendRun: the lock serializes
// the read window so back-to-back appends from concurrent goroutines
// can't lose-update each other.
func AppendRun(dir string, run Run) error {
	return WithTaskLock(dir, func() error {
		m, err := ReadMeta(dir)
		if err != nil {
			return err
		}
		if m == nil {
			return ErrMissingMeta
		}
		m.Runs = append(m.Runs, run)
		if err := WriteJSONAtomic(filepath.Join(dir, MetaFile), m, nil); err != nil {
			return err
		}
		emit(dir, MetaChangeEvent{
			TaskID:    taskIDFromDir(dir),
			Kind:      MetaChangeSpawned,
			SessionID: run.SessionID,
			Run:       &run,
		})
		return nil
	})
}

// UpdateRun applies patchFn to the run named by sessionID. patchFn
// mutates the Run in place (similar to TS Object.assign(run, patch));
// returning false from precondition skips the write entirely and
// returns (applied=false, nil). The optional precondition lets the
// caller reject demotions like done → failed under race.
//
// Mirrors libs/meta.ts updateRun. Emits a "transition" event when
// patchFn changes Status, "updated" otherwise.
func UpdateRun(dir, sessionID string, patchFn func(*Run), precondition func(Run) bool) (applied bool, err error) {
	err = WithTaskLock(dir, func() error {
		m, rerr := ReadMeta(dir)
		if rerr != nil {
			return rerr
		}
		if m == nil {
			return ErrMissingMeta
		}
		idx := -1
		for i, r := range m.Runs {
			if r.SessionID == sessionID {
				idx = i
				break
			}
		}
		if idx < 0 {
			return ErrRunNotFound
		}
		if precondition != nil && !precondition(m.Runs[idx]) {
			applied = false
			return nil
		}
		prevStatus := m.Runs[idx].Status
		patchFn(&m.Runs[idx])
		if werr := WriteJSONAtomic(filepath.Join(dir, MetaFile), m, nil); werr != nil {
			return werr
		}
		applied = true
		kind := MetaChangeUpdated
		if m.Runs[idx].Status != prevStatus {
			kind = MetaChangeTransition
		}
		runCopy := m.Runs[idx]
		emit(dir, MetaChangeEvent{
			TaskID:     taskIDFromDir(dir),
			Kind:       kind,
			SessionID:  sessionID,
			Run:        &runCopy,
			PrevStatus: prevStatus,
		})
		return nil
	})
	return
}

// RemoveSessionFromTask is the helper for the DELETE /api/sessions/<id>
// handler — filters a session out of the task's runs under the same
// lock that protects appendRun/updateRun. Returns true when the
// session was found + removed, false when meta is missing or the
// session wasn't linked to this task.
//
// Mirrors libs/meta.ts removeSessionFromTask.
func RemoveSessionFromTask(dir, sessionID string) (removed bool, err error) {
	err = WithTaskLock(dir, func() error {
		m, rerr := ReadMeta(dir)
		if rerr != nil {
			return rerr
		}
		if m == nil {
			return nil
		}
		before := len(m.Runs)
		// Filter-in-place: out aliases the same backing array as
		// m.Runs, but the value-copy `for _, r := range m.Runs`
		// snapshots each Run before the conditional append, so
		// overwriting earlier slots while iterating later ones is
		// safe. The post-loop `m.Runs = out` shortens the slice
		// header to the kept count.
		out := m.Runs[:0]
		for _, r := range m.Runs {
			if r.SessionID == sessionID {
				continue
			}
			out = append(out, r)
		}
		m.Runs = out
		if len(m.Runs) == before {
			return nil
		}
		if werr := WriteJSONAtomic(filepath.Join(dir, MetaFile), m, nil); werr != nil {
			return werr
		}
		emit(dir, MetaChangeEvent{
			TaskID: taskIDFromDir(dir),
			Kind:   MetaChangeWriteMeta,
		})
		removed = true
		return nil
	})
	return
}

// taskIDFromDir mirrors basename(dir) — every callsite uses
// filepath.Join(SESSIONS_DIR, taskID), so basename is the task id.
func taskIDFromDir(dir string) string {
	return filepath.Base(dir)
}
