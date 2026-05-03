package api

import (
	"fmt"
	"net/http"
	"path/filepath"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/stop1love1/claude-bridge/internal/memory"
	"github.com/stop1love1/claude-bridge/internal/meta"
	"github.com/stop1love1/claude-bridge/internal/runlifecycle"
	"github.com/stop1love1/claude-bridge/internal/spawn"
)

// ContinueTask — POST /api/tasks/{id}/continue. Re-spawns the
// coordinator with a resume prompt summarizing prior runs / open
// decisions. Mirrors libs/coordinator's continue path.
func ContinueTask(w http.ResponseWriter, r *http.Request) {
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
	// Find the latest finished coordinator run.
	var latestCoord *meta.Run
	for i := len(m.Runs) - 1; i >= 0; i-- {
		if m.Runs[i].Role == "coordinator" {
			cp := m.Runs[i]
			latestCoord = &cp
			break
		}
	}
	if latestCoord == nil {
		WriteJSON(w, http.StatusBadRequest, map[string]string{
			"error": "no coordinator run to continue — POST /api/tasks first",
		})
		return
	}
	if latestCoord.Status == meta.RunStatusRunning || latestCoord.Status == meta.RunStatusQueued {
		WriteJSON(w, http.StatusConflict, map[string]string{
			"error": "coordinator still active — kill it first",
		})
		return
	}
	if spawnerInstance == nil {
		WriteJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "spawner not configured"})
		return
	}
	resumeMsg := memory.BuildResumePrompt(*m, memory.ResumeOptions{
		ParentSessionID: latestCoord.SessionID,
	})
	bridgeRoot := getBridgeRoot()
	sess, err := spawnerInstance.ResumeClaude(bridgeRoot, latestCoord.SessionID, resumeMsg,
		&spawn.ChatSettings{Mode: "bypassPermissions", DisallowedTools: []string{"Task"}},
		"")
	if err != nil {
		WriteJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	startedAt := time.Now().UTC().Format(time.RFC3339Nano)
	_, _ = meta.UpdateRun(dir, latestCoord.SessionID, func(r *meta.Run) {
		r.Status = meta.RunStatusRunning
		r.StartedAt = &startedAt
		r.EndedAt = nil
	}, nil)
	runlifecycle.WireWithOpts(dir, latestCoord.SessionID, sess.Done, func() int {
		if sess.Cmd == nil || sess.Cmd.ProcessState == nil {
			return -1
		}
		return sess.Cmd.ProcessState.ExitCode()
	}, fmt.Sprintf("continue %s", id), runlifecycle.WireOpts{
		Ctx: r.Context(),
	})
	WriteJSON(w, http.StatusOK, map[string]any{
		"sessionId": latestCoord.SessionID,
		"continued": true,
	})
}
