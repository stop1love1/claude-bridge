package detect

// Read / write a DetectedScope from sessions/<task-id>/meta.json. Go
// port of libs/detect/cache.ts.
//
// Detection runs once per task at create time and the result is
// persisted alongside the task header. Subsequent coordinator + child
// spawns read this cached value — no re-detection per spawn — so
// coordinator and every child see the SAME scope.
//
// Refresh path: the explicit "POST /api/tasks/<id>/detect/refresh"
// route clears the cache and re-runs detection. Used when the user
// edits the task body.
//
// Stale-value gate: if the cached `taskBodyHash` doesn't match the
// current `taskBody`, the cache is treated as miss. This guards
// against older meta.json files written before detect was wired in,
// and against task-body edits that bypassed the refresh route.

import (
	"crypto/sha1"
	"encoding/hex"
	"fmt"

	"github.com/stop1love1/claude-bridge/internal/meta"
)

// HashTaskBody returns a short SHA-1 digest of a task body. SHA-1 is
// fine here — collision resistance isn't a security property, just a
// "did the body change" signal. Truncated to 16 hex chars to keep
// meta.json readable without sacrificing dispersion.
func HashTaskBody(body string) string {
	sum := sha1.Sum([]byte(body))
	return hex.EncodeToString(sum[:])[:16]
}

// ReadScopeCache returns the cached scope for a task. Returns
// (nil, nil) when:
//   - meta.json is missing
//   - the cache field is absent (older meta written before detect existed)
//   - the body hash doesn't match the current taskBody (stale)
//
// Always returns a fresh-seeming value to callers — they don't have
// to branch on staleness, just on nil vs scope.
func ReadScopeCache(sessionsDir string) (*DetectedScope, error) {
	m, err := meta.ReadMeta(sessionsDir)
	if err != nil {
		return nil, err
	}
	if m == nil {
		return nil, nil
	}
	entry, err := UnmarshalCacheEntry(m.DetectedScope)
	if err != nil {
		// A malformed cache entry shouldn't poison the dispatch path —
		// treat it as a miss and let detection re-populate. The TS
		// port did the same via try/catch around JSON.parse.
		return nil, nil
	}
	if entry == nil {
		return nil, nil
	}
	if entry.TaskBodyHash != HashTaskBody(m.TaskBody) {
		return nil, nil
	}
	return &entry.Scope, nil
}

// WriteScopeCache atomically writes the scope cache into a task's
// meta.json under the shared per-task lock. The caller doesn't need
// to worry about racing other meta writers (run lifecycle, task
// header edit) — this helper acquires the same WithTaskLock mutex
// they use.
func WriteScopeCache(sessionsDir string, scope DetectedScope) error {
	return meta.WithTaskLock(sessionsDir, func() error {
		m, err := meta.ReadMeta(sessionsDir)
		if err != nil {
			return err
		}
		if m == nil {
			// No meta to attach the cache to. Treat as a no-op rather
			// than an error — the caller's invocation order (create
			// meta first, then detect) is the one we expect, and a
			// missing-meta case here means the task was deleted out
			// from under us.
			return nil
		}
		entry := CacheEntry{
			TaskBodyHash: HashTaskBody(m.TaskBody),
			Scope:        scope,
		}
		raw, err := MarshalCacheEntry(entry)
		if err != nil {
			return fmt.Errorf("detect: marshal cache entry: %w", err)
		}
		m.DetectedScope = raw
		return meta.WriteMeta(sessionsDir, m)
	})
}

// ClearScopeCache drops the cached scope for a task. Used by the
// explicit refresh route before re-detection so a downstream read
// can't return the stale value mid-flight.
func ClearScopeCache(sessionsDir string) error {
	return meta.WithTaskLock(sessionsDir, func() error {
		m, err := meta.ReadMeta(sessionsDir)
		if err != nil {
			return err
		}
		if m == nil || len(m.DetectedScope) == 0 {
			return nil
		}
		m.DetectedScope = nil
		return meta.WriteMeta(sessionsDir, m)
	})
}
