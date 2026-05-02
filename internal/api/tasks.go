// Package api hand-written handlers. The oapi-codegen output in
// openapi_gen.go provides shared types; concrete behavior lives here
// alongside it (one file per Next.js route subtree).
package api

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"sync"

	"github.com/go-chi/chi/v5"

	"github.com/stop1love1/claude-bridge/internal/meta"
	"github.com/stop1love1/claude-bridge/internal/repos"
	"github.com/stop1love1/claude-bridge/internal/sessions"
	"github.com/stop1love1/claude-bridge/internal/usage"
)

// Config holds the file-system paths every handler needs. Plumbed in
// from cmd/bridge serve via server.Config; tests inject their own.
//
// The package keeps a single shared *Config so handlers don't have to
// thread it through every signature.
type Config struct {
	// SessionsDir is the bridge's sessions/<task-id>/ root. Defaults
	// to "./sessions" relative to cwd when unset.
	SessionsDir string
	// ProjectsRoot is ~/.claude/projects/ (or fixture equivalent).
	// Empty means "use sessions.DefaultClaudeProjectsRoot()". The
	// contract test fixture sets this to its own dir so a test against
	// an empty registry doesn't surface the operator's real session
	// folders in the response.
	ProjectsRoot string
}

var (
	cfgMu sync.RWMutex
	cfg   = &Config{SessionsDir: "sessions"}
)

// SetConfig swaps the package-global handler config. Idempotent;
// subsequent reads see the new pointer immediately.
func SetConfig(c *Config) {
	if c == nil {
		return
	}
	cfgMu.Lock()
	defer cfgMu.Unlock()
	cfg = c
}

func currentConfig() *Config {
	cfgMu.RLock()
	defer cfgMu.RUnlock()
	return cfg
}

// listMetaIDs scans sessions/ for entries that look like a task id
// (`t_YYYYMMDD_NNN`). Anything else is silently ignored — keeps stray
// files / dotfiles from polluting the response.
func listMetaIDs(sessionsDir string) []string {
	entries, err := os.ReadDir(sessionsDir)
	if err != nil {
		return nil
	}
	out := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		if !meta.IsValidTaskID(e.Name()) {
			continue
		}
		out = append(out, e.Name())
	}
	sort.Strings(out)
	return out
}

// metaToTask projects the on-disk meta.json into the public Task shape
// the GET /api/tasks endpoint returns. Mirrors libs/tasksStore.ts
// metaToTask: we pull only the header fields, never the runs.
type taskRow struct {
	ID      string           `json:"id"`
	Date    string           `json:"date"`
	Title   string           `json:"title"`
	Body    string           `json:"body"`
	Status  meta.TaskStatus  `json:"status"`
	Section meta.TaskSection `json:"section"`
	Checked bool             `json:"checked"`
	App     *string          `json:"app,omitempty"`
}

func metaToTask(m *meta.Meta) taskRow {
	// Date is the YYYY-MM-DD prefix of the task id (`t_YYYYMMDD_NNN`).
	date := ""
	if len(m.TaskID) >= 11 {
		date = m.TaskID[2:6] + "-" + m.TaskID[6:8] + "-" + m.TaskID[8:10]
	}
	return taskRow{
		ID:      m.TaskID,
		Date:    date,
		Title:   m.TaskTitle,
		Body:    m.TaskBody,
		Status:  m.TaskStatus,
		Section: m.TaskSection,
		Checked: m.TaskChecked,
		App:     m.TaskApp,
	}
}

// ListTasks is the Go side of GET /api/tasks. Walks sessions/<task>/
// and returns one row per task whose meta.json parses cleanly.
// Newest-first ordering by lexical task id (which encodes the date).
func ListTasks(w http.ResponseWriter, _ *http.Request) {
	c := currentConfig()
	ids := listMetaIDs(c.SessionsDir)
	tasks := make([]taskRow, 0, len(ids))
	for _, id := range ids {
		dir := filepath.Join(c.SessionsDir, id)
		m, err := meta.ReadMeta(dir)
		if err != nil || m == nil {
			continue
		}
		tasks = append(tasks, metaToTask(m))
	}
	// Newest first. Lexical sort on `t_YYYYMMDD_NNN` matches the TS
	// ordering exactly.
	sort.Slice(tasks, func(i, j int) bool { return tasks[i].ID > tasks[j].ID })
	WriteJSON(w, http.StatusOK, tasks)
}

// ListTasksMeta is the Go side of GET /api/tasks/meta — the batched
// {[taskId]: Meta} map the board polls every couple of seconds.
//
// S10 ports the read path. The stale-run reaper integration lands
// alongside the spawn registry wiring in the cmd/bridge serve command;
// for now we surface meta.json as-is.
func ListTasksMeta(w http.ResponseWriter, _ *http.Request) {
	c := currentConfig()
	ids := listMetaIDs(c.SessionsDir)
	out := make(map[string]*meta.Meta, len(ids))
	for _, id := range ids {
		m, err := meta.ReadMeta(filepath.Join(c.SessionsDir, id))
		if err != nil || m == nil {
			continue
		}
		out[id] = m
	}
	WriteJSON(w, http.StatusOK, out)
}

// GetTask is the Go side of GET /api/tasks/{id}. Returns 400 on a
// malformed id (defense in depth — chi only matches the URL pattern,
// not the task-id charset), 404 when meta.json doesn't exist.
func GetTask(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if !meta.IsValidTaskID(id) {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid task id"})
		return
	}
	c := currentConfig()
	m, err := meta.ReadMeta(filepath.Join(c.SessionsDir, id))
	if err != nil {
		WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if m == nil {
		WriteJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	WriteJSON(w, http.StatusOK, metaToTask(m))
}

// GetTaskMeta is the Go side of GET /api/tasks/{id}/meta. Returns the
// full Meta struct including the runs array — separate from GetTask
// (which strips runs) because the SSE-driven detail panel wants both
// the header AND every run record in one round-trip.
func GetTaskMeta(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if !meta.IsValidTaskID(id) {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid task id"})
		return
	}
	c := currentConfig()
	m, err := meta.ReadMeta(filepath.Join(c.SessionsDir, id))
	if err != nil {
		WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if m == nil {
		WriteJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	WriteJSON(w, http.StatusOK, m)
}

// GetTaskSummary is the Go side of GET /api/tasks/{id}/summary. Returns
// the contents of sessions/<id>/summary.md inside a JSON envelope so
// the existing UI fetcher (which already unpacks `{summary: string}`)
// keeps working.
func GetTaskSummary(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if !meta.IsValidTaskID(id) {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid task id"})
		return
	}
	c := currentConfig()
	path := filepath.Join(c.SessionsDir, id, "summary.md")
	body, err := os.ReadFile(path)
	if err != nil {
		WriteJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	WriteJSON(w, http.StatusOK, map[string]string{"summary": string(body)})
}

// PerRunUsage augments SessionUsage with the per-run identifiers the
// task-detail panel needs to display the breakdown row-by-row.
type PerRunUsage struct {
	usage.SessionUsage
	SessionID string `json:"sessionId"`
	Role      string `json:"role"`
	Repo      string `json:"repo"`
}

// taskUsageResponse is the shape the Next handler returns:
// `{ taskId, total, runs }`. Defining it explicitly keeps the JSON
// field order stable for contract tests.
type taskUsageResponse struct {
	TaskID string             `json:"taskId"`
	Total  usage.SessionUsage `json:"total"`
	Runs   []PerRunUsage      `json:"runs"`
}

// resolveSessionPath resolves a run's session jsonl path under
// ~/.claude/projects/<slug-of-repoCwd>/<sessionId>.jsonl. Returns ""
// when repoCwd is empty — the caller's row stays zero-valued.
func resolveSessionPath(reader *sessions.Reader, repoCwd, sessionID string) string {
	if repoCwd == "" {
		return ""
	}
	dir := reader.ProjectDirFor(repoCwd)
	return filepath.Join(dir, sessionID+".jsonl")
}

// GetTaskUsage reads the task's meta.json and sums per-run usage from
// each linked .jsonl. S17 wired the repos resolver so we can now turn
// each run's repo name back into an absolute cwd and read the actual
// .jsonl from ~/.claude/projects/<slug>/.
//
// Repos that can't be resolved (the operator removed an app from the
// registry between the spawn and the read) still appear in the
// response — the per-run row reports zeros instead of failing the
// whole request.
func GetTaskUsage(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if !meta.IsValidTaskID(id) {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid task id"})
		return
	}
	c := currentConfig()
	m, err := meta.ReadMeta(filepath.Join(c.SessionsDir, id))
	if err != nil {
		WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if m == nil {
		WriteJSON(w, http.StatusNotFound, map[string]string{"error": "task not found"})
		return
	}
	reader := sessions.New()
	resp := taskUsageResponse{TaskID: id, Runs: make([]PerRunUsage, 0, len(m.Runs))}
	for _, run := range m.Runs {
		row := PerRunUsage{SessionID: run.SessionID, Role: run.Role, Repo: run.Repo}
		if cwd, ok := repos.ResolveCwd(getBridgeRoot(), run.Repo); ok {
			path := resolveSessionPath(reader, cwd, run.SessionID)
			if path != "" {
				row.SessionUsage = usage.SumUsageFromJsonl(path)
			}
		}
		resp.Runs = append(resp.Runs, row)
		resp.Total = usage.Add(resp.Total, row.SessionUsage)
	}
	WriteJSON(w, http.StatusOK, resp)
}

// WriteJSON marshals body and writes it without a trailing newline.
// The encoder/decoder pair `json.NewEncoder + Encode` appends `\n`,
// which would diverge from Next's `NextResponse.json` (uses
// JSON.stringify, no newline) and break bytewise contract checks.
// Centralized here so every handler in this package picks up the
// same framing.
func WriteJSON(w http.ResponseWriter, status int, body any) {
	buf, err := json.Marshal(body)
	if err != nil {
		http.Error(w, `{"error":"encode failed"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(buf)
}
