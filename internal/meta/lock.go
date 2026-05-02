package meta

import "sync"

// withTaskLock provides per-task-directory mutual exclusion for the
// read-modify-write helpers (AppendRun, UpdateRun, RemoveSessionFromTask,
// any caller that does ReadMeta → mutate → WriteJSONAtomic).
//
// Without it, two concurrent callers (e.g. coordinator spawning two
// children, or a /link POST racing the lifecycle hook) would both
// observe the same pre-mutation file, mutate, and atomically rename —
// the second write silently overwrites the first, losing one run.
//
// The atomic file rename inside each helper still protects against
// partial writes; the lock just serializes the read window so back-to-
// back writes can't trample each other.
//
// Implemented as a sync.Map of *sync.Mutex keyed by absolute task dir.
// The TS module used a Map<string, Promise<unknown>> chain; sync.Mutex
// is the more idiomatic Go shape and gives the same serialization
// guarantee.
type taskLockRegistry struct {
	locks sync.Map // map[string]*sync.Mutex
}

var taskLocks = &taskLockRegistry{}

func (r *taskLockRegistry) get(dir string) *sync.Mutex {
	if m, ok := r.locks.Load(dir); ok {
		return m.(*sync.Mutex)
	}
	fresh := &sync.Mutex{}
	actual, _ := r.locks.LoadOrStore(dir, fresh)
	return actual.(*sync.Mutex)
}

// WithTaskLock runs fn while holding the per-dir mutex. Exported so
// other modules (tasksStore.UpdateTask, retry helpers) can serialize
// their own read-mutate-write sequences against the run-row helpers
// here. Without this, a UI title edit racing a child's AppendRun could
// silently drop the just-appended run.
func WithTaskLock(dir string, fn func() error) error {
	mu := taskLocks.get(dir)
	mu.Lock()
	defer mu.Unlock()
	return fn()
}
