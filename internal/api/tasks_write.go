package api

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/stop1love1/claude-bridge/internal/meta"
)

// CreateTaskBody is the POST /api/tasks request shape — same fields
// the Next handler accepts. App may be empty / null to mean "auto"
// (coordinator decides).
type CreateTaskBody struct {
	Title string  `json:"title,omitempty"`
	Body  string  `json:"body,omitempty"`
	App   *string `json:"app,omitempty"`
}

// CreateTask is the Go side of POST /api/tasks. Generates a fresh
// task id, writes meta.json, returns the new Task header.
//
// Spawn coordinator integration is deferred — it requires the apps /
// detect / coordinator packages (S16+ and beyond). The Next handler
// kicks off a coordinator spawn after createTask; for now the response
// carries `error: "coordinator-not-implemented"` so callers know the
// task exists but isn't actively being worked.
func CreateTask(w http.ResponseWriter, r *http.Request) {
	defer func() { _ = r.Body.Close() }()
	var body CreateTaskBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	rawBody := strings.TrimSpace(body.Body)
	title := strings.TrimSpace(body.Title)
	if title == "" {
		title = deriveTitle(rawBody)
	}
	if title == "" || (title == "(untitled)" && rawBody == "") {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "description required"})
		return
	}

	c := currentConfig()
	now := time.Now().UTC()

	existing := listMetaIDs(c.SessionsDir)
	id := meta.GenerateTaskID(now, existing)
	dir := filepath.Join(c.SessionsDir, id)

	var taskApp *string
	if body.App != nil {
		s := strings.TrimSpace(*body.App)
		if s != "" {
			taskApp = &s
		}
	}

	header := meta.Meta{
		TaskID:      id,
		TaskTitle:   title,
		TaskBody:    rawBody,
		TaskStatus:  meta.TaskStatusTodo,
		TaskSection: meta.SectionTodo,
		TaskChecked: false,
		TaskApp:     taskApp,
		CreatedAt:   now.Format(time.RFC3339Nano),
		Runs:        []meta.Run{},
	}
	if err := meta.CreateMeta(dir, header); err != nil {
		WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	row := metaToTask(&header)
	// Coordinator spawn intentionally not invoked here — that wires in
	// when the apps + detect + coordinator stack lands. Surface the
	// known-deferral via an error field so the UI can offer a manual
	// retry once the wiring catches up.
	resp := map[string]any{
		"id":      row.ID,
		"date":    row.Date,
		"title":   row.Title,
		"body":    row.Body,
		"status":  row.Status,
		"section": row.Section,
		"checked": row.Checked,
		"app":     row.App,
		"error":   "coordinator spawn deferred to S15+",
	}
	WriteJSON(w, http.StatusCreated, resp)
}

func deriveTitle(body string) string {
	for _, line := range strings.Split(body, "\n") {
		l := strings.TrimSpace(line)
		if l == "" {
			continue
		}
		if len(l) > 100 {
			return strings.TrimRight(l[:100], " ") + "…"
		}
		return l
	}
	return "(untitled)"
}

// UpdateTaskBody is the PATCH /api/tasks/{id} request shape. Every
// field is optional — the handler patches in place.
type UpdateTaskBody struct {
	Title   *string             `json:"title,omitempty"`
	Body    *string             `json:"body,omitempty"`
	Section *meta.TaskSection   `json:"section,omitempty"`
	Status  *meta.TaskStatus    `json:"status,omitempty"`
	Checked *bool               `json:"checked,omitempty"`
}

// UpdateTask is the Go side of PATCH /api/tasks/{id}. Mirrors
// libs/tasksStore.ts updateTask exactly — same lock, same field
// patching rules, same emitTaskSection notification.
//
// CLAUDE.md contract: only the human user can promote a task to
// DONE. The cookie-vs-internal-token gate ports with auth (S13/S14);
// for now every caller is allowed to set DONE — the gate is documented
// in a TODO so the auth port doesn't forget to add it.
func UpdateTask(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if !meta.IsValidTaskID(id) {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid task id"})
		return
	}
	defer func() { _ = r.Body.Close() }()
	var patch UpdateTaskBody
	if err := json.NewDecoder(r.Body).Decode(&patch); err != nil {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if patch.Section != nil {
		if _, ok := meta.SectionStatus[*patch.Section]; !ok {
			WriteJSON(w, http.StatusBadRequest, map[string]string{
				"error": "invalid section",
			})
			return
		}
	}
	// TODO(S13/S14 auth): if patch.Section == SectionDone, require a
	// cookie-authenticated request — block coordinators / internal
	// callers from auto-promoting tasks past the user-confirmation
	// review gate. The Next handler does this via verifyRequestAuth.

	c := currentConfig()
	dir := filepath.Join(c.SessionsDir, id)

	var updated *meta.Meta
	var prevSection meta.TaskSection
	err := meta.WithTaskLock(dir, func() error {
		m, err := meta.ReadMeta(dir)
		if err != nil {
			return err
		}
		if m == nil {
			return meta.ErrMissingMeta
		}
		prevSection = m.TaskSection
		if patch.Title != nil {
			m.TaskTitle = *patch.Title
		}
		if patch.Body != nil {
			m.TaskBody = *patch.Body
		}
		if patch.Checked != nil {
			m.TaskChecked = *patch.Checked
		}
		if patch.Section != nil {
			m.TaskSection = *patch.Section
			m.TaskStatus = meta.SectionStatus[*patch.Section]
		} else if patch.Status != nil {
			m.TaskStatus = *patch.Status
		}
		if werr := meta.WriteMeta(dir, m); werr != nil {
			return werr
		}
		updated = m
		return nil
	})
	if err != nil {
		if err == meta.ErrMissingMeta {
			WriteJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
			return
		}
		WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	meta.EmitTaskSection(dir, prevSection, updated.TaskSection, updated.TaskTitle, updated.TaskChecked)
	WriteJSON(w, http.StatusOK, metaToTask(updated))
}

// DeleteTaskResponse mirrors libs/tasksStore.ts DeleteTaskResult.
// SessionsDeleted/Failed are placeholders until internal/repos (S17)
// lets us resolve a run's repo cwd to remove the .jsonl files; for now
// we just rm the task dir and report 0 for both.
type DeleteTaskResponse struct {
	OK              bool `json:"ok"`
	SessionsDeleted int  `json:"sessionsDeleted"`
	SessionsFailed  int  `json:"sessionsFailed"`
}

// DeleteTask is the Go side of DELETE /api/tasks/{id}. Removes the
// sessions/<id>/ directory entirely.
//
// TODO(S13/S14 auth): require a cookie-authenticated request — the
// Next handler does this so a compromised child can't nuke arbitrary
// tasks via the internal-token bypass.
//
// TODO(S15/S17): kill any still-running children + remove linked
// .jsonl files under ~/.claude/projects/<slug>/. Both require the
// spawn registry / repos resolution that come in later sessions.
func DeleteTask(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if !meta.IsValidTaskID(id) {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid task id"})
		return
	}
	c := currentConfig()
	dir := filepath.Join(c.SessionsDir, id)
	if _, err := os.Stat(dir); err != nil {
		WriteJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if err := os.RemoveAll(dir); err != nil {
		WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	// Drop the cache entry so a follow-up GET sees the absence.
	meta.ResetCacheForTests() // safe to call here — re-initializes the LRU
	WriteJSON(w, http.StatusOK, DeleteTaskResponse{OK: true})
}

// PutTaskSummary writes summary.md inside the task's session dir.
// Idempotent — overwrites whatever was there. The body is the raw
// markdown the coordinator (or operator) wrote.
type PutTaskSummaryBody struct {
	Summary string `json:"summary"`
}

func PutTaskSummary(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if !meta.IsValidTaskID(id) {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid task id"})
		return
	}
	defer func() { _ = r.Body.Close() }()
	var body PutTaskSummaryBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	c := currentConfig()
	dir := filepath.Join(c.SessionsDir, id)
	if _, err := os.Stat(dir); err != nil {
		WriteJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	path := filepath.Join(dir, "summary.md")
	if err := meta.WriteStringAtomic(path, body.Summary, nil); err != nil {
		WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// LinkSessionBody is the POST /api/tasks/{id}/link request shape.
// Self-registration call from a child claude process so the bridge UI
// + future Claude sessions can find it via meta.json.
type LinkSessionBody struct {
	SessionID string `json:"sessionId"`
	Role      string `json:"role"`
	Repo      string `json:"repo"`
	Status    string `json:"status,omitempty"`
}

// LinkSession is the Go side of POST /api/tasks/{id}/link. Appends a
// run row to meta.json (idempotent — if the session id is already
// present, updates in place).
//
// Auth: the route is exempt from cookie auth in the Next code (uses
// the X-Bridge-Internal-Token header instead) so children can self-
// register without a session cookie. The token check ports with the
// middleware in S13/S14; for now the route is open.
func LinkSession(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if !meta.IsValidTaskID(id) {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid task id"})
		return
	}
	defer func() { _ = r.Body.Close() }()
	var body LinkSessionBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if body.SessionID == "" {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "sessionId required"})
		return
	}
	c := currentConfig()
	dir := filepath.Join(c.SessionsDir, id)

	now := time.Now().UTC().Format(time.RFC3339Nano)
	role := body.Role
	if role == "" {
		role = "coordinator"
	}
	status := body.Status
	if status == "" {
		status = "running"
	}

	// Try to update an existing run with the same session id first;
	// fall back to appending. Both run inside WithTaskLock so the
	// dedup is race-safe.
	var inserted bool
	err := meta.WithTaskLock(dir, func() error {
		m, rerr := meta.ReadMeta(dir)
		if rerr != nil {
			return rerr
		}
		if m == nil {
			return meta.ErrMissingMeta
		}
		for i := range m.Runs {
			if m.Runs[i].SessionID == body.SessionID {
				m.Runs[i].Role = role
				m.Runs[i].Repo = body.Repo
				m.Runs[i].Status = meta.RunStatus(status)
				if m.Runs[i].StartedAt == nil {
					n := now
					m.Runs[i].StartedAt = &n
				}
				return meta.WriteMeta(dir, m)
			}
		}
		startedAt := now
		m.Runs = append(m.Runs, meta.Run{
			SessionID: body.SessionID,
			Role:      role,
			Repo:      body.Repo,
			Status:    meta.RunStatus(status),
			StartedAt: &startedAt,
		})
		inserted = true
		return meta.WriteMeta(dir, m)
	})
	if err != nil {
		if err == meta.ErrMissingMeta {
			WriteJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
			return
		}
		WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{
		"ok":       true,
		"inserted": inserted,
	})
}
