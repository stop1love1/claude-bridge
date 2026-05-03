package api

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/stop1love1/claude-bridge/internal/apps"
	"github.com/stop1love1/claude-bridge/internal/meta"
	"github.com/stop1love1/claude-bridge/internal/sessions"
)

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

	cwd, ok := apps.ResolveCwd(getBridgeRoot(), body.Repo)
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

	// Wrap the entire read → write → rename sequence in a per-session
	// lock. The same key is used by spawn paths that touch the session
	// file, so a Spawn racing a Rewind serializes here rather than
	// trampling each other through the file system.
	//
	// We key the lock on the absolute session file path so two rewinds
	// of different sessions on the same host don't block each other.
	// The "is child alive?" check above is still racy with re-spawn,
	// but the lock at least guarantees that any in-flight spawn that
	// also takes this lock either completes before we start the rename
	// or queues until we're done.
	lockKey := filepath.Clean(file)
	// Drop the per-session lock entry on function exit so the registry
	// doesn't grow unboundedly with each rewind. RemoveLockFor must run
	// AFTER the WithTaskLock callback has returned — i.e. after the
	// mutex has been released — which a top-level defer guarantees.
	//
	// Race note (per meta.RemoveLockFor docstring): if a concurrent
	// rewind on the same path arrives between our Unlock and Delete it
	// would observe the registered mutex; if it arrives after Delete it
	// allocates a fresh mutex. Either is fine here — rewinds on the
	// same session are idempotent (the second one no-ops on a missing
	// uuid), and the lock has been released so no in-flight holder is
	// orphaned.
	defer meta.RemoveLockFor(lockKey)

	type rewindResult struct {
		kept    int
		dropped int
	}
	var result rewindResult
	var statusCode int
	var errMsg string

	lockErr := meta.WithTaskLock(lockKey, func() error {
		raw, err := os.ReadFile(file)
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				statusCode = http.StatusNotFound
				errMsg = "session file not found"
				return nil
			}
			statusCode = http.StatusInternalServerError
			errMsg = err.Error()
			return nil
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
			statusCode = http.StatusNotFound
			errMsg = "uuid not found in session"
			return nil
		}

		kept := strings.Join(lines[:cutoff+1], "\n")
		if !strings.HasSuffix(kept, "\n") {
			kept += "\n"
		}
		// Stage to <file>.<pid>.<rand>.tmp so a crash leaves the
		// original intact. Rename is atomic on POSIX and on Windows
		// when both paths are on the same volume (always the case
		// here — tmp is a sibling).
		suffix := make([]byte, 6)
		if _, rerr := rand.Read(suffix); rerr != nil {
			statusCode = http.StatusInternalServerError
			errMsg = rerr.Error()
			return nil
		}
		tmp := file + "." + strconv.Itoa(os.Getpid()) + "." + hex.EncodeToString(suffix) + ".tmp"
		if werr := os.WriteFile(tmp, []byte(kept), 0o644); werr != nil {
			statusCode = http.StatusInternalServerError
			errMsg = werr.Error()
			return nil
		}
		if rerr := os.Rename(tmp, file); rerr != nil {
			_ = os.Remove(tmp)
			statusCode = http.StatusInternalServerError
			errMsg = rerr.Error()
			return nil
		}

		result = rewindResult{kept: cutoff + 1, dropped: len(lines) - cutoff - 1}
		return nil
	})
	if lockErr != nil {
		WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": lockErr.Error()})
		return
	}
	if errMsg != "" {
		WriteJSON(w, statusCode, map[string]string{"error": errMsg})
		return
	}

	WriteJSON(w, http.StatusOK, map[string]any{
		"kept":    result.kept,
		"dropped": result.dropped,
	})
}
