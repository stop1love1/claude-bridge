package quality_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stop1love1/claude-bridge/internal/quality"
)

// --- ReadHouseRules ---------------------------------------------------

func TestReadHouseRulesMissingReturnsEmpty(t *testing.T) {
	// Empty fallback — the caller skips rendering the house-rules
	// section entirely when this is "", so the contract is critical.
	if got := quality.ReadHouseRules(t.TempDir()); got != "" {
		t.Fatalf("missing file: got %q, want \"\"", got)
	}
}

func TestReadHouseRulesEmptyRoot(t *testing.T) {
	if got := quality.ReadHouseRules(""); got != "" {
		t.Fatalf("empty root: got %q, want \"\"", got)
	}
}

func TestReadHouseRulesTrimsAndReturns(t *testing.T) {
	dir := t.TempDir()
	body := "  # Rules\n\nbe nice\n\n"
	if err := os.WriteFile(filepath.Join(dir, "HOUSE_RULES.md"), []byte(body), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	got := quality.ReadHouseRules(dir)
	want := "# Rules\n\nbe nice"
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestReadHouseRulesCapsAtBudget(t *testing.T) {
	// Verify the 32 KB cap holds — feed 40 KB of 'A' and ensure the
	// returned value does not exceed the cap.
	dir := t.TempDir()
	huge := strings.Repeat("A", 40*1024)
	if err := os.WriteFile(filepath.Join(dir, "HOUSE_RULES.md"), []byte(huge), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	got := quality.ReadHouseRules(dir)
	if len(got) > 32*1024 {
		t.Fatalf("uncapped: len=%d, want <= %d", len(got), 32*1024)
	}
	if len(got) == 0 {
		t.Fatalf("cap collapsed to empty")
	}
}

// --- ListPlaybooks ----------------------------------------------------

func TestListPlaybooksMissingDir(t *testing.T) {
	got := quality.ListPlaybooks(t.TempDir())
	if got == nil {
		t.Fatalf("missing dir returned nil; expected empty map for nil-safe iteration")
	}
	if len(got) != 0 {
		t.Fatalf("missing dir returned %d entries: %v", len(got), got)
	}
}

func TestListPlaybooksEmptyRoot(t *testing.T) {
	got := quality.ListPlaybooks("")
	if got == nil || len(got) != 0 {
		t.Fatalf("empty root: got %v", got)
	}
}

func TestListPlaybooksSkipsNonMarkdown(t *testing.T) {
	root := t.TempDir()
	pb := filepath.Join(root, "playbooks")
	if err := os.MkdirAll(pb, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	files := map[string]string{
		"reviewer.md":  "# reviewer\n",
		"coder.md":     "  coder body  ",
		"notes.txt":    "ignored",
		"empty.md":     "   \n  ",       // trimmed-empty → skipped
		"README.MD":    "wrong case",    // case-sensitive .md
	}
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(pb, name), []byte(body), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	// Subdir should not be enumerated as a playbook.
	if err := os.Mkdir(filepath.Join(pb, "subdir"), 0o755); err != nil {
		t.Fatalf("mkdir sub: %v", err)
	}

	got := quality.ListPlaybooks(root)
	if len(got) != 2 {
		t.Fatalf("got %d entries (%v), want 2", len(got), got)
	}
	if got["reviewer"] != "# reviewer" {
		t.Errorf("reviewer = %q, want %q", got["reviewer"], "# reviewer")
	}
	if got["coder"] != "coder body" {
		t.Errorf("coder = %q, want %q", got["coder"], "coder body")
	}
	if _, ok := got["notes"]; ok {
		t.Errorf("notes.txt should not appear")
	}
	if _, ok := got["empty"]; ok {
		t.Errorf("trimmed-empty playbook should be skipped")
	}
}

// --- promptStore ------------------------------------------------------

func TestReadOriginalPromptMissing(t *testing.T) {
	// Fail-soft contract: every retry caller treats "" as
	// "no original prompt available, use failure context only".
	if got := quality.ReadOriginalPrompt(t.TempDir()); got != "" {
		t.Fatalf("missing: got %q, want \"\"", got)
	}
}

func TestReadOriginalPromptEmptyDir(t *testing.T) {
	if got := quality.ReadOriginalPrompt(""); got != "" {
		t.Fatalf("empty dir: got %q, want \"\"", got)
	}
}

func TestPromptStoreRoundtrip(t *testing.T) {
	dir := t.TempDir()
	want := "rendered prompt\nwith newlines and unicode: ✓"
	if err := quality.WriteOriginalPrompt(dir, want); err != nil {
		t.Fatalf("write: %v", err)
	}
	got := quality.ReadOriginalPrompt(dir)
	if got != want {
		t.Fatalf("roundtrip mismatch:\n got: %q\nwant: %q", got, want)
	}
	// Atomic-write contract: file is on disk after the call, no
	// `.tmp` siblings linger.
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	for _, e := range entries {
		if strings.Contains(e.Name(), ".tmp") {
			t.Errorf("leftover tmp file: %s", e.Name())
		}
	}
}

func TestWriteOriginalPromptOverwrites(t *testing.T) {
	// Coordinator may re-render the same task across attempts —
	// the second write must replace, not append.
	dir := t.TempDir()
	if err := quality.WriteOriginalPrompt(dir, "first"); err != nil {
		t.Fatalf("write 1: %v", err)
	}
	if err := quality.WriteOriginalPrompt(dir, "second"); err != nil {
		t.Fatalf("write 2: %v", err)
	}
	if got := quality.ReadOriginalPrompt(dir); got != "second" {
		t.Fatalf("got %q, want %q", got, "second")
	}
}

func TestWriteOriginalPromptEmptyDirErrors(t *testing.T) {
	// Writer side surfaces the programming error rather than
	// silently no-op'ing — see WriteOriginalPrompt comment.
	if err := quality.WriteOriginalPrompt("", "x"); err == nil {
		t.Fatalf("empty taskDir: expected error, got nil")
	}
}
