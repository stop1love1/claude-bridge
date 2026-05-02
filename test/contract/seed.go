package contract

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// Fixture is an isolated bridge state on disk used by a single contract
// check. Each Fixture owns a temp directory laid out like the bridge
// data root: bridge.json at the top, sessions/<task-id>/meta.json for
// each task, and .claude/projects/<slug>/<sid>.jsonl for spawned Claude
// sessions. Handlers under verification read from these paths via the
// internal/config package once that wiring lands (S10+); the pilot
// listTasksMeta stub ignores the fixture entirely and just proves the
// framework end-to-end.
type Fixture struct {
	Root        string
	SessionsDir string
	BridgeJSON  string
	ProjectsDir string
}

// NewFixture creates a tempdir-backed Fixture. The caller must invoke
// Cleanup when done — use NewFixtureT in tests for automatic cleanup.
func NewFixture() (*Fixture, error) {
	root, err := os.MkdirTemp("", "bridge-contract-")
	if err != nil {
		return nil, fmt.Errorf("mktemp: %w", err)
	}
	f := &Fixture{
		Root:        root,
		SessionsDir: filepath.Join(root, "sessions"),
		BridgeJSON:  filepath.Join(root, "bridge.json"),
		ProjectsDir: filepath.Join(root, ".claude", "projects"),
	}
	if err := os.MkdirAll(f.SessionsDir, 0o755); err != nil {
		_ = os.RemoveAll(root)
		return nil, err
	}
	if err := os.MkdirAll(f.ProjectsDir, 0o755); err != nil {
		_ = os.RemoveAll(root)
		return nil, err
	}
	return f, nil
}

// NewFixtureT is the testing.TB variant — registers Cleanup so the
// fixture goes away when the test finishes.
func NewFixtureT(tb testing.TB) *Fixture {
	tb.Helper()
	f, err := NewFixture()
	if err != nil {
		tb.Fatalf("contract: new fixture: %v", err)
	}
	tb.Cleanup(func() { _ = f.Cleanup() })
	return f
}

// Cleanup removes the fixture's temp directory.
func (f *Fixture) Cleanup() error {
	if f == nil || f.Root == "" {
		return nil
	}
	return os.RemoveAll(f.Root)
}

// SetBridgeJSON writes the given bytes to <root>/bridge.json.
func (f *Fixture) SetBridgeJSON(content []byte) error {
	return os.WriteFile(f.BridgeJSON, content, 0o644)
}

// AddTaskMeta writes <sessions>/<id>/meta.json with the given JSON
// bytes. The directory is created if missing.
func (f *Fixture) AddTaskMeta(id string, meta []byte) error {
	dir := filepath.Join(f.SessionsDir, id)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, "meta.json"), meta, 0o644)
}

// AddSessionLog writes a fake Claude Code JSONL session file at
// .claude/projects/<slug>/<sid>.jsonl. lines are joined with `\n`
// and a trailing newline is appended (matches Claude's own format).
func (f *Fixture) AddSessionLog(slug, sid string, lines []string) error {
	dir := filepath.Join(f.ProjectsDir, slug)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	path := filepath.Join(dir, sid+".jsonl")
	body := ""
	for _, l := range lines {
		body += l + "\n"
	}
	return os.WriteFile(path, []byte(body), 0o644)
}
