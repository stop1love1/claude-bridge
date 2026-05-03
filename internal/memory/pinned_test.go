package memory_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stop1love1/claude-bridge/internal/memory"
)

func TestLoadPinnedFilesEmptyInputs(t *testing.T) {
	if got := memory.LoadPinnedFiles("", []string{"a.txt"}); got != nil {
		t.Errorf("empty appPath should return nil, got %v", got)
	}
	if got := memory.LoadPinnedFiles(t.TempDir(), nil); got != nil {
		t.Errorf("nil pinnedFiles should return nil, got %v", got)
	}
}

func TestLoadPinnedFilesReadsRelative(t *testing.T) {
	app := t.TempDir()
	mustWrite(t, filepath.Join(app, "ROUTES.md"), "route table")
	mustWrite(t, filepath.Join(app, "src", "types.ts"), "export type X = 1;")

	got := memory.LoadPinnedFiles(app, []string{"ROUTES.md", "src/types.ts"})
	if len(got) != 2 {
		t.Fatalf("want 2 entries, got %d: %+v", len(got), got)
	}
	if got[0].Rel != "ROUTES.md" || got[0].Content != "route table" || got[0].Truncated {
		t.Errorf("entry 0: %+v", got[0])
	}
	// Rel is normalized to posix even if the operator pinned with a
	// backslash on Windows.
	if got[1].Rel != "src/types.ts" {
		t.Errorf("entry 1 rel: got %q", got[1].Rel)
	}
}

func TestLoadPinnedFilesNormalizesBackslashes(t *testing.T) {
	app := t.TempDir()
	mustWrite(t, filepath.Join(app, "src", "x.ts"), "x")
	got := memory.LoadPinnedFiles(app, []string{`src\x.ts`})
	if len(got) != 1 {
		t.Fatalf("want 1 entry, got %d", len(got))
	}
	if got[0].Rel != "src/x.ts" {
		t.Errorf("rel not normalized: %q", got[0].Rel)
	}
}

func TestLoadPinnedFilesSkipsMissing(t *testing.T) {
	app := t.TempDir()
	mustWrite(t, filepath.Join(app, "exists.md"), "hi")

	got := memory.LoadPinnedFiles(app, []string{"missing.md", "exists.md"})
	if len(got) != 1 || got[0].Rel != "exists.md" {
		t.Errorf("expected only exists.md: %+v", got)
	}
}

func TestLoadPinnedFilesSkipsAbsoluteAndTraversal(t *testing.T) {
	app := t.TempDir()
	// A real file outside the app root, then try to pull it in via
	// both an absolute reference and a `..` relative path.
	outside := filepath.Join(t.TempDir(), "secret.txt")
	mustWrite(t, outside, "secret")

	pins := []string{
		outside,                        // absolute → reject
		"../" + filepath.Base(outside), // traversal → reject
		"..",                           // bare parent → reject
		"../../etc/passwd",             // deep traversal → reject
	}
	got := memory.LoadPinnedFiles(app, pins)
	if len(got) != 0 {
		t.Errorf("expected zero entries from unsafe pins, got %+v", got)
	}
}

func TestLoadPinnedFilesEnforcesMaxFiles(t *testing.T) {
	app := t.TempDir()
	pins := make([]string, 0, memory.PinnedMaxFiles+5)
	for i := 0; i < memory.PinnedMaxFiles+5; i++ {
		name := "f" + pad(i) + ".md"
		mustWrite(t, filepath.Join(app, name), "x")
		pins = append(pins, name)
	}
	got := memory.LoadPinnedFiles(app, pins)
	if len(got) != memory.PinnedMaxFiles {
		t.Errorf("expected %d entries, got %d", memory.PinnedMaxFiles, len(got))
	}
}

func TestLoadPinnedFilesCapsContent(t *testing.T) {
	app := t.TempDir()
	huge := strings.Repeat("a", memory.PinnedPerFileCapBytes*2)
	mustWrite(t, filepath.Join(app, "big.md"), huge)
	exact := strings.Repeat("b", memory.PinnedPerFileCapBytes)
	mustWrite(t, filepath.Join(app, "exact.md"), exact)
	small := "small"
	mustWrite(t, filepath.Join(app, "small.md"), small)

	got := memory.LoadPinnedFiles(app, []string{"big.md", "exact.md", "small.md"})
	if len(got) != 3 {
		t.Fatalf("want 3, got %d", len(got))
	}
	if !got[0].Truncated || len(got[0].Content) != memory.PinnedPerFileCapBytes {
		t.Errorf("big.md not capped/truncated: truncated=%v len=%d", got[0].Truncated, len(got[0].Content))
	}
	// Exactly at the cap is NOT truncated — readCapped uses an N+1
	// buffer specifically so equality at the boundary stays clean.
	if got[1].Truncated || len(got[1].Content) != memory.PinnedPerFileCapBytes {
		t.Errorf("exact.md should not be truncated: truncated=%v len=%d", got[1].Truncated, len(got[1].Content))
	}
	if got[2].Truncated || got[2].Content != small {
		t.Errorf("small.md mishandled: truncated=%v content=%q", got[2].Truncated, got[2].Content)
	}
}

func TestLoadPinnedFilesSkipsBlankAndWhitespace(t *testing.T) {
	app := t.TempDir()
	mustWrite(t, filepath.Join(app, "ok.md"), "ok")
	got := memory.LoadPinnedFiles(app, []string{"", "   ", "ok.md"})
	if len(got) != 1 || got[0].Rel != "ok.md" {
		t.Errorf("expected only ok.md: %+v", got)
	}
}

func mustWrite(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", path, err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}
