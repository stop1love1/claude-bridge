package api

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/stop1love1/claude-bridge/internal/repos"
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

// spawnerInstance is the package-global *spawn.Spawner. cmd/bridge
// serve injects the production instance at startup.
var spawnerInstance *spawn.Spawner

// SetSpawner installs the package-global spawner. Idempotent.
func SetSpawner(s *spawn.Spawner) { spawnerInstance = s }

// SessionMessageBody is the POST /api/sessions/{sessionId}/message
// payload. `repo` is the registered app name owning this session; the
// bridge resolves it to an absolute cwd via internal/repos before
// shelling out to claude.
type SessionMessageBody struct {
	Message  string                  `json:"message"`
	Repo     string                  `json:"repo"`
	Settings *spawn.ChatSettings     `json:"settings,omitempty"`
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
	cwd, ok := repos.ResolveCwd(getBridgeRoot(), body.Repo)
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
