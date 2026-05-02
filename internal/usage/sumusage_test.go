package usage_test

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stop1love1/claude-bridge/internal/usage"
)

// writeUsageFile mirrors the TS test helper: writes `turns` assistant
// lines whose usage block sums to (input, output).
func writeUsageFile(t *testing.T, dir, name string, input, output, turns int64) string {
	t.Helper()
	path := filepath.Join(dir, name)
	var lines []string
	for i := int64(0); i < turns; i++ {
		entry := map[string]any{
			"type": "assistant",
			"message": map[string]any{
				"usage": map[string]any{
					"input_tokens":  input / turns,
					"output_tokens": output / turns,
				},
			},
		}
		b, err := json.Marshal(entry)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		lines = append(lines, string(b))
	}
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
	return path
}

func TestSumUsageHitOnSameMtimeAndSize(t *testing.T) {
	usage.ResetUsageCacheForTests()
	dir := t.TempDir()
	file := writeUsageFile(t, dir, "a.jsonl", 100, 50, 2)

	first := usage.SumUsageFromJsonl(file)
	want := usage.SessionUsage{InputTokens: 100, OutputTokens: 50, Turns: 2}
	if first != want {
		t.Fatalf("first read: got %+v, want %+v", first, want)
	}

	stBefore, err := os.Stat(file)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	// Overwrite with different totals but identical byte length, then
	// restore the mtime — the cache key (path, mtime, size) should
	// still hit.
	newRaw := `{"type":"assistant","message":{"usage":{"input_tokens":9999,"output_tokens":9999}}}` + "\n"
	switch {
	case len(newRaw) < int(stBefore.Size()):
		newRaw += strings.Repeat(" ", int(stBefore.Size())-len(newRaw))
	case len(newRaw) > int(stBefore.Size()):
		newRaw = newRaw[:stBefore.Size()]
	}
	if int64(len(newRaw)) != stBefore.Size() {
		t.Fatalf("padding broke: got %d bytes, want %d", len(newRaw), stBefore.Size())
	}
	if err := os.WriteFile(file, []byte(newRaw), 0o644); err != nil {
		t.Fatalf("rewrite: %v", err)
	}
	if err := os.Chtimes(file, stBefore.ModTime(), stBefore.ModTime()); err != nil {
		t.Fatalf("chtimes: %v", err)
	}

	second := usage.SumUsageFromJsonl(file)
	if second != first {
		t.Errorf("cache hit broken: got %+v, want %+v (cached pre-mutation)", second, first)
	}
}

func TestSumUsageMissesOnMtimeChange(t *testing.T) {
	usage.ResetUsageCacheForTests()
	dir := t.TempDir()
	file := writeUsageFile(t, dir, "b.jsonl", 10, 5, 1)
	first := usage.SumUsageFromJsonl(file)
	if first.InputTokens != 10 {
		t.Fatalf("first read: got %d, want 10", first.InputTokens)
	}

	st, err := os.Stat(file)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	// Bump mtime by 5s — same content, but cache key changes.
	newMtime := st.ModTime().Add(5 * time.Second)
	if err := os.Chtimes(file, st.ModTime(), newMtime); err != nil {
		t.Fatalf("chtimes: %v", err)
	}
	second := usage.SumUsageFromJsonl(file)
	if second.InputTokens != 10 {
		t.Errorf("post-mtime-bump (same content): got %d, want 10", second.InputTokens)
	}

	// Now rewrite with different size to confirm the fresh re-read path.
	newRaw := `{"type":"assistant","message":{"usage":{"input_tokens":999,"output_tokens":999}}}` + "\n"
	if err := os.WriteFile(file, []byte(newRaw), 0o644); err != nil {
		t.Fatalf("rewrite: %v", err)
	}
	third := usage.SumUsageFromJsonl(file)
	if third.InputTokens != 999 {
		t.Errorf("post-rewrite: got %d, want 999", third.InputTokens)
	}
}

func TestSumUsageMissesOnSizeChange(t *testing.T) {
	usage.ResetUsageCacheForTests()
	dir := t.TempDir()
	file := writeUsageFile(t, dir, "c.jsonl", 1, 1, 1)
	usage.SumUsageFromJsonl(file)

	// Append a second line — size grows, cache must miss.
	two := strings.Join([]string{
		`{"type":"assistant","message":{"usage":{"input_tokens":1,"output_tokens":1}}}`,
		`{"type":"assistant","message":{"usage":{"input_tokens":7,"output_tokens":7}}}`,
	}, "\n") + "\n"
	if err := os.WriteFile(file, []byte(two), 0o644); err != nil {
		t.Fatalf("append: %v", err)
	}
	out := usage.SumUsageFromJsonl(file)
	if out.InputTokens != 8 || out.Turns != 2 {
		t.Errorf("got %+v, want input=8 turns=2", out)
	}
}

func TestSumUsageDoesNotCacheMissingFile(t *testing.T) {
	usage.ResetUsageCacheForTests()
	dir := t.TempDir()
	ghost := filepath.Join(dir, "ghost.jsonl")

	a := usage.SumUsageFromJsonl(ghost)
	if a.Turns != 0 {
		t.Fatalf("missing file should yield zeros, got %+v", a)
	}
	// Now create the file. If the prior miss had been cached, this would
	// still return zeros.
	body := `{"type":"assistant","message":{"usage":{"input_tokens":42,"output_tokens":17}}}` + "\n"
	if err := os.WriteFile(ghost, []byte(body), 0o644); err != nil {
		t.Fatalf("create: %v", err)
	}
	b := usage.SumUsageFromJsonl(ghost)
	if b.InputTokens != 42 {
		t.Errorf("after create: got %+v, want input=42", b)
	}
}

func TestSumUsageEvictsOldestWhenCapExceeded(t *testing.T) {
	usage.ResetUsageCacheForTests()
	dir := t.TempDir()
	f0 := writeUsageFile(t, dir, "evict.jsonl", 1, 1, 1)
	v0 := usage.SumUsageFromJsonl(f0)
	if v0.InputTokens != 1 {
		t.Fatalf("initial read: %+v", v0)
	}

	// Cap is 256; touch 300 distinct files so f0 falls out of LRU.
	for i := 0; i < 300; i++ {
		fi := writeUsageFile(t, dir, fmt.Sprintf("fill-%d.jsonl", i), int64(i), 0, 1)
		usage.SumUsageFromJsonl(fi)
	}

	// Mutate f0; if its cache entry had survived eviction we'd still see
	// the old totals.
	body := `{"type":"assistant","message":{"usage":{"input_tokens":555,"output_tokens":555}}}` + "\n"
	if err := os.WriteFile(f0, []byte(body), 0o644); err != nil {
		t.Fatalf("mutate f0: %v", err)
	}
	v0b := usage.SumUsageFromJsonl(f0)
	if v0b.InputTokens != 555 {
		t.Errorf("after eviction-and-mutate: got %+v, want input=555", v0b)
	}
}
