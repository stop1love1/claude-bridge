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

// ReadMeta loads meta.json from the task's sessions dir, returning
// (nil, nil) when the file doesn't exist OR fails to parse — a
// truncated file (mid-rename power-cut, hand-edit, sync race) would
// otherwise propagate a SyntaxError through every listTasks() / boot
// sweep / SSE caller and freeze the dashboard until the file is
// deleted manually.
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
		// Distinguish ENOENT from parse error — rename race is benign,
		// no warning needed; corrupt-JSON signals operator-fixable damage.
		// Don't poison the cache with the parse failure: next read after
		// a writeMeta will pick up the fresh bytes.
		return nil, nil
	}
	metaCache.put(dir, &m)
	return &m, nil
}

// CreateMeta initializes a fresh meta.json. Caller passes the header
// fields; runs is initialized empty. Mirrors libs/meta.ts createMeta.
//
// Emits writeMeta on the package-global event bus so subscribers
// (S12 SSE route) see the create.
func CreateMeta(dir string, header Meta) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	header.Runs = nil // Wire shape uses [], not null — fixed below.
	if header.Runs == nil {
		header.Runs = []Run{}
	}
	if err := WriteJSONAtomic(filepath.Join(dir, MetaFile), header, nil); err != nil {
		return err
	}
	emit(dir, MetaChangeEvent{
		TaskID: taskIDFromDir(dir),
		Kind:   MetaChangeWriteMeta,
	})
	return nil
}

// WriteMeta replaces meta.json on disk and notifies subscribers.
// Mirrors libs/meta.ts writeMeta — emits a writeMeta event (no per-run
// signal — task header changed).
func WriteMeta(dir string, m *Meta) error {
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
