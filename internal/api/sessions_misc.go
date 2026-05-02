package api

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"os"
	"strconv"
	"strings"

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

// SessionRewindBody is the POST /api/sessions/{sessionId}/rewind
// payload. `repo` resolves the .jsonl path under
// ~/.claude/projects/<slug>/. `uuid` names the line that becomes the
// new tail — every entry whose uuid follows it in file order is
// dropped. Mirrors the TS shape exactly so the existing UI keeps
// working.
type SessionRewindBody struct {
	Repo string `json:"repo"`
	UUID string `json:"uuid"`
}

// SessionRewind — POST /api/sessions/{sessionId}/rewind. Truncates
// the session .jsonl after the entry whose `uuid` field matches
// body.UUID. The named entry itself is kept ("rewind to here, this is
// now my latest turn") — claude on the next resume sees the
// conversation as if every later turn never happened.
//
// Refuses to rewind a session with a live child registered: the child
// holds the file open and appends; truncating mid-write would either
// drop an in-progress turn or leave the child writing at a now-invalid
// offset and corrupt the file.
//
// Atomic write: stage to a sibling .tmp then rename. A crash mid-write
// leaves the original intact rather than truncated.
func SessionRewind(w http.ResponseWriter, r *http.Request) {
	sid := chi.URLParam(r, "sessionId")
	if !sessions.IsValidSessionID(sid) {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid sessionId"})
		return
	}
	defer func() { _ = r.Body.Close() }()
	var body SessionRewindBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	if body.Repo == "" || body.UUID == "" {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "repo and uuid required"})
		return
	}

	if spawnRegistry != nil {
		if _, alive := spawnRegistry.Get(sid); alive {
			WriteJSON(w, http.StatusConflict, map[string]string{
				"error": "session is still running — stop the run before rewinding",
			})
			return
		}
	}

	cwd, ok := repos.ResolveCwd(getBridgeRoot(), body.Repo)
	if !ok {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "unknown repo"})
		return
	}
	reader := sessions.New()
	file, ok := reader.ResolveSessionFile(cwd, sid)
	if !ok {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid session repo"})
		return
	}
	raw, err := os.ReadFile(file)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			WriteJSON(w, http.StatusNotFound, map[string]string{"error": "session file not found"})
			return
		}
		WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	lines := strings.Split(string(raw), "\n")
	cutoff := -1
	for i, line := range lines {
		if line == "" {
			continue
		}
		var probe struct {
			UUID string `json:"uuid"`
		}
		if err := json.Unmarshal([]byte(line), &probe); err != nil {
			continue
		}
		if probe.UUID == body.UUID {
			cutoff = i
			break
		}
	}
	if cutoff == -1 {
		WriteJSON(w, http.StatusNotFound, map[string]string{"error": "uuid not found in session"})
		return
	}

	kept := strings.Join(lines[:cutoff+1], "\n")
	if !strings.HasSuffix(kept, "\n") {
		kept += "\n"
	}
	// Stage to <file>.<pid>.<rand>.tmp so a crash leaves the original
	// intact. Rename is atomic on POSIX and on Windows when both paths
	// are on the same volume (always the case here — tmp is a sibling).
	suffix := make([]byte, 6)
	if _, rerr := rand.Read(suffix); rerr != nil {
		WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": rerr.Error()})
		return
	}
	tmp := file + "." + strconv.Itoa(os.Getpid()) + "." + hex.EncodeToString(suffix) + ".tmp"
	if werr := os.WriteFile(tmp, []byte(kept), 0o644); werr != nil {
		WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": werr.Error()})
		return
	}
	if rerr := os.Rename(tmp, file); rerr != nil {
		_ = os.Remove(tmp)
		WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": rerr.Error()})
		return
	}

	WriteJSON(w, http.StatusOK, map[string]any{
		"kept":    cutoff + 1,
		"dropped": len(lines) - cutoff - 1,
	})
}
