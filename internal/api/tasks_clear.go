package api

import (
	"net/http"
	"path/filepath"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/stop1love1/claude-bridge/internal/meta"
)

// ClearTask — POST /api/tasks/{id}/clear. SIGTERMs every active child
// + flips queued/running rows to failed. Mirrors libs/coordinator's
// clear path. Idempotent — clearing an already-cleared task is a
// no-op success.
func ClearTask(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if !meta.IsValidTaskID(id) {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid task id"})
		return
	}
	c := currentConfig()
	dir := filepath.Join(c.SessionsDir, id)
	m, err := meta.ReadMeta(dir)
	if err != nil {
		WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if m == nil {
		WriteJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	killed := 0
	for _, run := range m.Runs {
		if run.Status != meta.RunStatusQueued && run.Status != meta.RunStatusRunning {
			continue
		}
		if spawnRegistry != nil && spawnRegistry.Kill(run.SessionID) {
			killed++
		}
		now := time.Now().UTC().Format(time.RFC3339Nano)
		_, _ = meta.UpdateRun(dir, run.SessionID, func(r *meta.Run) {
			r.Status = meta.RunStatusFailed
			r.EndedAt = &now
		}, func(cur meta.Run) bool {
			// Only flip if still active — don't demote done/failed.
			return cur.Status == meta.RunStatusQueued || cur.Status == meta.RunStatusRunning
		})
	}
	WriteJSON(w, http.StatusOK, map[string]any{
		"ok":     true,
		"killed": killed,
	})
}
