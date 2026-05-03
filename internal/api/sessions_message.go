package api

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/stop1love1/claude-bridge/internal/apps"
	"github.com/stop1love1/claude-bridge/internal/sessions"
	"github.com/stop1love1/claude-bridge/internal/spawn"
)

// spawnerInstance is the package-global *spawn.Spawner. cmd/bridge
// serve injects the production instance at startup.
var spawnerInstance *spawn.Spawner

// SetSpawner installs the package-global spawner. Idempotent.
func SetSpawner(s *spawn.Spawner) { spawnerInstance = s }

// SessionMessageBody is the POST /api/sessions/{sessionId}/message
// payload. `repo` is the registered app name owning this session; the
// bridge resolves it to an absolute cwd via internal/apps before
// shelling out to claude.
type SessionMessageBody struct {
	Message  string              `json:"message"`
	Repo     string              `json:"repo"`
	Settings *spawn.ChatSettings `json:"settings,omitempty"`
}

// SessionMessage — POST /api/sessions/{sessionId}/message. Resumes
// the named claude session with a new user turn via spawn.ResumeClaude.
//
// S17 unblocks this — the repos resolver maps `body.repo` to an
// absolute cwd and the spawner is shared with the rest of the bridge
// so the kill endpoint can find the new child.
func SessionMessage(w http.ResponseWriter, r *http.Request) {
	sid := chi.URLParam(r, "sessionId")
	if !sessions.IsValidSessionID(sid) {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid sessionId"})
		return
	}
	if spawnerInstance == nil {
		WriteJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "spawner not configured — cmd/bridge serve must call api.SetSpawner",
		})
		return
	}
	defer func() { _ = r.Body.Close() }()
	var body SessionMessageBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	if body.Message == "" {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "message required"})
		return
	}
	cwd, ok := apps.ResolveCwd(getBridgeRoot(), body.Repo)
	if !ok {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "unknown repo"})
		return
	}
	sess, err := spawnerInstance.ResumeClaude(cwd, sid, body.Message, body.Settings, "")
	if err != nil {
		WriteJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{
		"sessionId": sess.SessionID,
		"pid":       sess.Cmd.Process.Pid,
	})
}
