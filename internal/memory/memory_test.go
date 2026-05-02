package memory_test

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/stop1love1/claude-bridge/internal/memory"
)

func TestMemoryFilePathLayout(t *testing.T) {
	app := absTempDir(t)
	got := memory.MemoryFilePath(app)
	want := filepath.Join(app, ".bridge", "memory.md")
	if got != want {
		t.Fatalf("MemoryFilePath = %q, want %q", got, want)
	}
}

func TestLoadMemoryRejectsRelativeAndMissing(t *testing.T) {
	if _, ok := memory.LoadMemory(""); ok {
		t.Errorf("empty appPath should be rejected")
	}
	// Relative path is rejected even if it exists, because the loader
	// is called with bridge.json's `path` field which is normalized
	// to absolute upstream.
	if _, ok := memory.LoadMemory("relative/path"); ok {
		t.Errorf("relative appPath should be rejected")
	}
	// Absolute path with no memory file → empty + false.
	app := absTempDir(t)
	if _, ok := memory.LoadMemory(app); ok {
		t.Errorf("missing memory.md should return ok=false")
	}
}

func TestAppendMemoryCreatesFileAndPrepends(t *testing.T) {
	app := absTempDir(t)

	first, ok := memory.AppendMemory(app, "When tests pass → run vet")
	if !ok || first != "- When tests pass → run vet" {
		t.Fatalf("first append: got %q ok=%v", first, ok)
	}

	second, ok := memory.AppendMemory(app, "When CI fails → check the lockfile")
	if !ok || second != "- When CI fails → check the lockfile" {
		t.Fatalf("second append: got %q ok=%v", second, ok)
	}

	raw, ok := memory.LoadMemory(app)
	if !ok {
		t.Fatalf("LoadMemory after appends returned ok=false")
	}
	lines := strings.Split(raw, "\n")
	if lines[0] != second {
		t.Errorf("newest entry should be first: got %q", lines[0])
	}
	if lines[1] != first {
		t.Errorf("older entry should follow: got %q", lines[1])
	}
}

func TestAppendMemoryFlattensAndStripsBullet(t *testing.T) {
	app := absTempDir(t)
	bullet, ok := memory.AppendMemory(app, "-   foo\n\tbar  baz")
	if !ok {
		t.Fatalf("AppendMemory returned ok=false")
	}
	// Leading "- " stripped, internal whitespace runs collapsed.
	if bullet != "- foo bar baz" {
		t.Errorf("got %q, want %q", bullet, "- foo bar baz")
	}
}

func TestAppendMemoryRejectsEmptyAndInvalidPath(t *testing.T) {
	app := absTempDir(t)
	if _, ok := memory.AppendMemory(app, "   \n\t  "); ok {
		t.Errorf("whitespace-only entry should be rejected")
	}
	if _, ok := memory.AppendMemory("", "hello"); ok {
		t.Errorf("empty appPath should be rejected")
	}
	if _, ok := memory.AppendMemory("relative", "hello"); ok {
		t.Errorf("relative appPath should be rejected")
	}
}

func TestAppendMemoryIdempotentOnDuplicateHead(t *testing.T) {
	app := absTempDir(t)
	a, _ := memory.AppendMemory(app, "rule one")
	b, _ := memory.AppendMemory(app, "rule one") // duplicate of head
	if a != b {
		t.Errorf("duplicate append should return same bullet, got %q vs %q", a, b)
	}

	raw, _ := memory.LoadMemory(app)
	count := strings.Count(raw, "- rule one")
	if count != 1 {
		t.Errorf("expected one persisted entry, got %d:\n%s", count, raw)
	}
}

func TestAppendMemoryCapsEntrySize(t *testing.T) {
	app := absTempDir(t)
	huge := strings.Repeat("x", memory.MaxEntryBytes*3)
	bullet, ok := memory.AppendMemory(app, huge)
	if !ok {
		t.Fatalf("AppendMemory returned ok=false")
	}
	// Bullet is "- " + payload; payload capped to MaxEntryBytes.
	payload := strings.TrimPrefix(bullet, "- ")
	if len(payload) > memory.MaxEntryBytes {
		t.Errorf("payload len %d exceeds cap %d", len(payload), memory.MaxEntryBytes)
	}
}

func TestAppendMemoryTruncatesUTF8WithoutSplit(t *testing.T) {
	app := absTempDir(t)
	// Each "→" is 3 bytes; pad with ASCII so the cap lands inside a
	// codepoint and we exercise the rune-boundary guard.
	entry := strings.Repeat("a", memory.MaxEntryBytes-2) + "→→→"
	bullet, ok := memory.AppendMemory(app, entry)
	if !ok {
		t.Fatalf("AppendMemory returned ok=false")
	}
	// strings.ToValidUTF8 with a sentinel would replace bad bytes;
	// we verify directly by re-encoding.
	for _, r := range bullet {
		if r == '�' {
			t.Fatalf("bullet contains replacement char (split codepoint): %q", bullet)
		}
	}
}

func TestAppendMemoryCapsFileBytes(t *testing.T) {
	app := absTempDir(t)
	// Each entry is roughly 1 KB; 50 of them comfortably exceed the
	// 32 KB file cap. After cap trimming the file should be <= cap
	// and end on a full bullet (no half-line at EOF).
	chunk := strings.Repeat("y", memory.MaxEntryBytes-10)
	for i := 0; i < 50; i++ {
		// Vary the entry so idempotency doesn't no-op the appends.
		if _, ok := memory.AppendMemory(app, chunk+pad(i)); !ok {
			t.Fatalf("append %d failed", i)
		}
	}
	data, err := os.ReadFile(memory.MemoryFilePath(app))
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if len(data) > memory.MaxFileBytes+1 { // +1 for the trailing newline
		t.Errorf("file size %d exceeds cap %d", len(data), memory.MaxFileBytes)
	}
	// Every line in the file should start with "- " — i.e. no
	// half-bullet at the top from a mid-codepoint or mid-line cut.
	for _, ln := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		if !strings.HasPrefix(ln, "- ") {
			t.Fatalf("found half-bullet line %q in:\n%s", ln, data)
		}
	}
}

func TestTopMemoryEntriesSkipsBlanksAndHeaders(t *testing.T) {
	app := absTempDir(t)
	// Write a hand-crafted file with comments + blank lines so we
	// verify the parser's filtering rather than re-deriving it via
	// AppendMemory.
	contents := "# header to skip\n\n- alpha\n\n- beta\n- gamma\n"
	if err := os.MkdirAll(filepath.Dir(memory.MemoryFilePath(app)), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(memory.MemoryFilePath(app), []byte(contents), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	got := memory.TopMemoryEntries(app, 0)
	want := []string{"- alpha", "- beta", "- gamma"}
	if !equalStrings(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}

	limited := memory.TopMemoryEntries(app, 2)
	if !equalStrings(limited, []string{"- alpha", "- beta"}) {
		t.Errorf("limit=2: got %v", limited)
	}
}

func TestTopMemoryEntriesEmptyWhenMissing(t *testing.T) {
	app := absTempDir(t)
	if got := memory.TopMemoryEntries(app, 0); len(got) != 0 {
		t.Errorf("expected nil/empty, got %v", got)
	}
}

func TestRenderMemorySection(t *testing.T) {
	if memory.RenderMemorySection(nil) != "" {
		t.Errorf("nil entries should render empty string")
	}
	out := memory.RenderMemorySection([]string{"- alpha", "beta"})
	if !strings.Contains(out, "## Memory") {
		t.Errorf("missing heading: %q", out)
	}
	// Bare entries get a "- " prefix; pre-bulleted ones are passed
	// through as-is.
	if !strings.Contains(out, "- alpha\n") {
		t.Errorf("missing pre-bulleted entry: %q", out)
	}
	if !strings.Contains(out, "- beta\n") {
		t.Errorf("missing auto-bulleted entry: %q", out)
	}
}

func TestAppendMemoryConcurrent(t *testing.T) {
	// Concurrent appends should serialize via the per-app lock so no
	// entry is silently dropped to a lost update.
	app := absTempDir(t)
	const n = 25
	var wg sync.WaitGroup
	wg.Add(n)
	for i := 0; i < n; i++ {
		go func(i int) {
			defer wg.Done()
			memory.AppendMemory(app, "rule "+pad(i))
		}(i)
	}
	wg.Wait()

	raw, ok := memory.LoadMemory(app)
	if !ok {
		t.Fatalf("LoadMemory returned ok=false")
	}
	bullets := 0
	for _, ln := range strings.Split(raw, "\n") {
		if strings.HasPrefix(ln, "- rule ") {
			bullets++
		}
	}
	if bullets != n {
		t.Errorf("expected %d bullets, got %d", n, bullets)
	}
}

// absTempDir returns a guaranteed-absolute temp dir. t.TempDir is
// already absolute on every supported OS, but we filepath.Abs it
// defensively so a future test refactor can't introduce a relative
// path that silently exercises the rejection branch instead of the
// happy path.
func absTempDir(t *testing.T) string {
	t.Helper()
	d := t.TempDir()
	abs, err := filepath.Abs(d)
	if err != nil {
		t.Fatalf("abs: %v", err)
	}
	return abs
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func pad(i int) string {
	return string(rune('A'+(i%26))) + string(rune('A'+((i/26)%26)))
}
