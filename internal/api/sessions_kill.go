package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/stop1love1/claude-bridge/internal/sessions"
	"github.com/stop1love1/claude-bridge/internal/spawn"
)

// spawnRegistry is the package-global handle to the spawn package's
// registry. cmd/bridge serve injects the production registry; tests
// either provide their own (for kill-flow assertions) or leave it nil
// (kill returns 404).
var spawnRegistry *spawn.Registry

// SetSpawnRegistry plumbs the spawn registry into the api handlers.
// Idempotent.
func SetSpawnRegistry(r *spawn.Registry) {
	spawnRegistry = r
}

// SessionKill — POST /api/sessions/{sessionId}/kill. SIGTERMs the
// child claude process, escalating to SIGKILL after 3 s. Returns 404
// when no live process is registered for the session.
//
// Mirrors libs/spawnRegistry.ts killChild + the Next handler. Meta-row
// patching (flip `running` → `failed`) needs the meta wiring done by
// the cmd/bridge serve command; for now this just signals the child.
func SessionKill(w http.ResponseWriter, r *http.Request) {
	sid := chi.URLParam(r, "sessionId")
	if !sessions.IsValidSessionID(sid) {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid sessionId"})
		return
	}
	if spawnRegistry == nil {
		WriteJSON(w, http.StatusNotFound, map[string]string{"error": "no live process"})
		return
	}
	if !spawnRegistry.Kill(sid) {
		WriteJSON(w, http.StatusNotFound, map[string]string{"error": "no live process"})
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
}
