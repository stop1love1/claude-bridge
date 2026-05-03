package api

import (
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/stop1love1/claude-bridge/internal/sessions"
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
