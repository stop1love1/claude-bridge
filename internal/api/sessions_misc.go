package api

import (
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/stop1love1/claude-bridge/internal/sessions"
	"github.com/stop1love1/claude-bridge/internal/spawn"
)

// SessionTail — GET /api/sessions/{sessionId}/tail. Streams JSONL
// records from the session log incrementally. Modes:
//
//   - default: forward tail starting at `?since=<offset>` (defaults to 0)
//   - backward: when `?before=<offset>` is set, returns the window
//     ending at that offset (used by the chat composer scroll-up)
//
// Required `?repo=<absolute cwd>` so the bridge can find the project
// dir under ~/.claude/projects/<slug>/.
func SessionTail(w http.ResponseWriter, r *http.Request) {
	sid := chi.URLParam(r, "sessionId")
	if !sessions.IsValidSessionID(sid) {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid sessionId"})
		return
	}
	q := r.URL.Query()
	repo := q.Get("repo")

	reader := sessions.New()
	file, ok := reader.ResolveSessionFile(repo, sid)
	if !ok {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid session repo"})
		return
	}

	if before := q.Get("before"); before != "" {
		beforeOff, err := strconv.ParseInt(before, 10, 64)
		if err != nil {
			WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid before"})
			return
		}
		out, err := sessions.TailJsonlBefore(file, beforeOff, 0)
		if err != nil {
			WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		WriteJSON(w, http.StatusOK, out)
		return
	}

	since := int64(0)
	if s := q.Get("since"); s != "" {
		n, err := strconv.ParseInt(s, 10, 64)
		if err != nil {
			WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid since"})
			return
		}
		since = n
	}
	out, err := sessions.TailJsonl(file, since)
	if err != nil {
		WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	WriteJSON(w, http.StatusOK, out)
}

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

// SessionMessage — POST /api/sessions/{sessionId}/message. Stub for
// S29: full implementation needs the Spawner.ResumeClaude wiring +
// internal/repos to resolve the run's cwd. Wires the route so the
// chi mux is complete; returns 503 with a deferral note.
//
// Once cmd/bridge serve plumbs the spawner + repos resolver into the
// api package, this calls Spawner.ResumeClaude(cwd, sid, message,
// settings, settingsPath) and returns the new spawn handle.
func SessionMessage(w http.ResponseWriter, r *http.Request) {
	sid := chi.URLParam(r, "sessionId")
	if !sessions.IsValidSessionID(sid) {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid sessionId"})
		return
	}
	WriteJSON(w, http.StatusServiceUnavailable, map[string]string{
		"error":    "ResumeClaude wiring deferred (S15 + S17)",
		"sessionId": sid,
	})
}

// SessionRewind — POST /api/sessions/{sessionId}/rewind. Stub for
// S29: rewind mutates the session .jsonl to undo the last N turns,
// which requires careful byte-level surgery against claude's transcript
// format + checkpointing. Lands when the chat-composer rewind UX is
// actively wired in the Vite frontend port (S33+).
func SessionRewind(w http.ResponseWriter, r *http.Request) {
	sid := chi.URLParam(r, "sessionId")
	if !sessions.IsValidSessionID(sid) {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid sessionId"})
		return
	}
	WriteJSON(w, http.StatusServiceUnavailable, map[string]string{
		"error":     "rewind algorithm deferred (S33+)",
		"sessionId": sid,
	})
}
