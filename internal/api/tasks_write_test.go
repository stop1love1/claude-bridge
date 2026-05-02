package api_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rs/zerolog"

	"github.com/stop1love1/claude-bridge/internal/api"
	"github.com/stop1love1/claude-bridge/internal/meta"
	"github.com/stop1love1/claude-bridge/internal/server"
)

// newTestServer wires the chi router against a fresh sessions dir.
// Returns the handler + that dir so tests can assert on-disk state.
// Also stashes the dir on the package-level testSessionsDir so the
// link-test helper can grab it for post-call disk inspection.
func newTestServer(t *testing.T) (http.Handler, string) {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "sessions")
	api.SetConfig(&api.Config{SessionsDir: dir})
	meta.ResetCacheForTests()
	testSessionsDir = dir
	return server.NewHandler(server.Config{Logger: zerolog.New(io.Discard)}), dir
}

// readMetaIgnoreCache reads the meta.json bypassing any cached entry —
// after a delete, the cache may still hold the pre-delete snapshot
// briefly. Used to assert on-disk state.
func readMetaIgnoreCache(dir string) (*meta.Meta, error) {
	meta.ResetCacheForTests()
	return meta.ReadMeta(dir)
}

func doJSON(t *testing.T, h http.Handler, method, path string, body any) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	var reader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		reader = bytes.NewReader(b)
	}
	req := httptest.NewRequest(method, path, reader)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	var got map[string]any
	if rec.Body.Len() > 0 {
		_ = json.Unmarshal(rec.Body.Bytes(), &got)
	}
	return rec, got
}

func TestCreateTaskAssignsTaskIDAndPersists(t *testing.T) {
	h, sessionsDir := newTestServer(t)
	rec, got := doJSON(t, h, "POST", "/api/tasks", map[string]any{
		"title": "test task",
		"body":  "do the thing",
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("status: got %d, want 201; body=%s", rec.Code, rec.Body.String())
	}
	id, _ := got["id"].(string)
	if id == "" || !meta.IsValidTaskID(id) {
		t.Fatalf("id: got %q, want valid task id", id)
	}
	// meta.json should exist on disk and round-trip.
	m, err := meta.ReadMeta(filepath.Join(sessionsDir, id))
	if err != nil || m == nil {
		t.Fatalf("ReadMeta: err=%v meta=%v", err, m)
	}
	if m.TaskTitle != "test task" || m.TaskBody != "do the thing" {
		t.Errorf("on-disk meta: %+v", m)
	}
}

func TestCreateTaskRejectsEmptyDescription(t *testing.T) {
	h, _ := newTestServer(t)
	rec, _ := doJSON(t, h, "POST", "/api/tasks", map[string]any{})
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status: got %d, want 400", rec.Code)
	}
}

func TestPatchTaskUpdatesSection(t *testing.T) {
	h, _ := newTestServer(t)
	_, created := doJSON(t, h, "POST", "/api/tasks", map[string]any{"body": "first task"})
	id := created["id"].(string)

	rec, got := doJSON(t, h, "PATCH", "/api/tasks/"+id, map[string]any{
		"section": "DOING",
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if got["section"] != "DOING" || got["status"] != "doing" {
		t.Errorf("post-patch row: %+v", got)
	}
}

func TestPatchTaskRejectsInvalidSection(t *testing.T) {
	h, _ := newTestServer(t)
	_, created := doJSON(t, h, "POST", "/api/tasks", map[string]any{"body": "x"})
	id := created["id"].(string)
	rec, _ := doJSON(t, h, "PATCH", "/api/tasks/"+id, map[string]any{"section": "WHATEVER"})
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status: got %d, want 400", rec.Code)
	}
}

func TestPatchTaskInvalidIDReturns400(t *testing.T) {
	h, _ := newTestServer(t)
	rec, _ := doJSON(t, h, "PATCH", "/api/tasks/not-a-real-id", map[string]any{"title": "x"})
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status: got %d, want 400", rec.Code)
	}
}

func TestDeleteTaskRemovesDir(t *testing.T) {
	h, sessionsDir := newTestServer(t)
	_, created := doJSON(t, h, "POST", "/api/tasks", map[string]any{"body": "delete me"})
	id := created["id"].(string)

	rec, got := doJSON(t, h, "DELETE", "/api/tasks/"+id, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("delete status: got %d, want 200", rec.Code)
	}
	if got["ok"] != true {
		t.Errorf("delete ok: %+v", got)
	}
	// Dir should be gone — ReadMeta returns (nil, nil) for missing file.
	m, _ := readMetaIgnoreCache(filepath.Join(sessionsDir, id))
	if m != nil {
		t.Error("expected meta.json gone after delete")
	}
}

func TestPutTaskSummaryWritesFile(t *testing.T) {
	h, sessionsDir := newTestServer(t)
	_, created := doJSON(t, h, "POST", "/api/tasks", map[string]any{"body": "summary me"})
	id := created["id"].(string)

	rec, _ := doJSON(t, h, "PUT", "/api/tasks/"+id+"/summary", map[string]any{
		"summary": "## Summary\n\nDone.",
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d, want 200", rec.Code)
	}
	// File should exist with the body we wrote.
	body, err := readFile(filepath.Join(sessionsDir, id, "summary.md"))
	if err != nil {
		t.Fatalf("read summary.md: %v", err)
	}
	if !strings.Contains(body, "## Summary") {
		t.Errorf("summary content: %q", body)
	}
}

func TestLinkSessionAppendsAndUpdatesIdempotently(t *testing.T) {
	h, _ := newTestServer(t)
	_, created := doJSON(t, h, "POST", "/api/tasks", map[string]any{"body": "link target"})
	id := created["id"].(string)

	sid := "11111111-1111-4111-8111-111111111111"
	rec, got := doJSON(t, h, "POST", "/api/tasks/"+id+"/link", map[string]any{
		"sessionId": sid,
		"role":      "coordinator",
		"repo":      "bridge",
		"status":    "running",
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("first link: status %d body=%s", rec.Code, rec.Body.String())
	}
	if got["inserted"] != true {
		t.Errorf("first link should insert: %+v", got)
	}
	// Re-link with same sessionId — should update, not duplicate.
	rec, got = doJSON(t, h, "POST", "/api/tasks/"+id+"/link", map[string]any{
		"sessionId": sid,
		"role":      "coder",
		"repo":      "bridge",
		"status":    "done",
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("second link: status %d", rec.Code)
	}
	if got["inserted"] != false {
		t.Errorf("second link should NOT insert (update path): %+v", got)
	}
	// Re-read meta — exactly one run, with role=coder.
	c := apiConfig()
	m, _ := meta.ReadMeta(filepath.Join(c.SessionsDir, id))
	if len(m.Runs) != 1 {
		t.Fatalf("runs: got %d, want 1", len(m.Runs))
	}
	if m.Runs[0].Role != "coder" || m.Runs[0].Status != "done" {
		t.Errorf("post-update run: %+v", m.Runs[0])
	}
}

// readFile is a tiny helper that returns string + error, sparing every
// caller a manual `_ = err` dance.
func readFile(p string) (string, error) {
	b, err := readBytes(p)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

func readBytes(p string) ([]byte, error) {
	// Avoid importing os in the test by going through meta's
	// atomic-write sibling helper… actually just use os.ReadFile.
	return readFileOS(p)
}

// apiConfig pokes at the package-global config for assertions. Tests
// only — production callers use api.SetConfig.
func apiConfig() *api.Config {
	// We don't expose a getter; reconstruct via the same SessionsDir
	// pattern. For these tests, the SessionsDir is the dir we passed
	// to newTestServer; use a t.Helper to grab it from the caller.
	// Simplest: rewrite tests to keep dir local. (Done above — see
	// TestDeleteTaskRemovesDir for the pattern.) This shim is here
	// because TestLinkSession needs the sessions root after the fact.
	// We grab it via a small trick: the caller test already saved
	// sessionsDir, but we threw it away — refactor below would be
	// nicer; for one test it's fine to read from the env we set.
	return readApiConfigViaEnv()
}

// readApiConfigViaEnv exists to keep the test stable without exposing
// internals. Tests that need the config save their dir locally.
func readApiConfigViaEnv() *api.Config {
	return &api.Config{SessionsDir: testSessionsDir}
}

// testSessionsDir is set by newTestServer so tests that need post-call
// disk inspection can grab the path without re-threading it.
var testSessionsDir string
