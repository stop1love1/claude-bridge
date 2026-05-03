package memory_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stop1love1/claude-bridge/internal/memory"
	"github.com/stop1love1/claude-bridge/internal/meta"
	"github.com/stop1love1/claude-bridge/internal/symbol"
)

// ---------------------------------------------------------------------
// context_attach.go
// ---------------------------------------------------------------------

func TestTokenizeFiltersStopwordsAndShortAndNumeric(t *testing.T) {
	// "Form-State" splits + lowercases → form, state. "Add/a/new/for/
	// please/review" are stopwords. "2025" is purely numeric → drops.
	// "v3" is 2 chars → drops on the len<3 guard. "form" appears twice
	// in the input → dedup keeps one. Insertion order is preserved.
	got := memory.Tokenize("Add a New Form-State hook for 2025 — please review v3 form")
	want := []string{"form", "state", "hook"}
	if !equalStringSlices(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
}

func TestTokenizeEmptyAndStopwordsOnly(t *testing.T) {
	if got := memory.Tokenize(""); len(got) != 0 {
		t.Errorf("empty input: got %v", got)
	}
	if got := memory.Tokenize("the and a fix update"); len(got) != 0 {
		t.Errorf("stopwords-only: got %v", got)
	}
}

func TestScoreSymbolSubstringMatch(t *testing.T) {
	s := symbol.SymbolEntry{Name: "useFormState", File: "hooks/useFormState.ts", Kind: symbol.KindFunction}
	// ScoreSymbol counts +1 PER TOKEN that appears anywhere in the
	// `file + " " + name` haystack — repeated occurrences of the same
	// token still only score 1.
	if got := memory.ScoreSymbol(s, []string{"form"}); got != 1 {
		t.Errorf("substring 'form' should score 1, got %d", got)
	}
	if got := memory.ScoreSymbol(s, []string{"form", "state", "missing"}); got != 2 {
		t.Errorf("two matches expected, got %d", got)
	}
	if got := memory.ScoreSymbol(s, nil); got != 0 {
		t.Errorf("no tokens → 0, got %d", got)
	}
}

func TestPickCandidateFilesAggregatesAndFilters(t *testing.T) {
	syms := []symbol.SymbolEntry{
		{Name: "useFormState", File: "hooks/forms.ts"},
		{Name: "FormError", File: "hooks/forms.ts"},
		{Name: "Button", File: "components/Button.tsx"},
		{Name: "unrelated", File: "lib/util.ts"},
	}
	got := memory.PickCandidateFiles(syms, []string{"form"})
	// hooks/forms.ts: 2 symbols × 1 token each = 2 → meets ReferenceMinScore.
	// components/Button.tsx: 0 → dropped.
	// lib/util.ts: 0 → dropped.
	if len(got) != 1 || got[0].File != "hooks/forms.ts" || got[0].Score != 2 {
		t.Errorf("got %+v", got)
	}
}

func TestPickCandidateFilesEmptyTokens(t *testing.T) {
	if got := memory.PickCandidateFiles([]symbol.SymbolEntry{{Name: "X", File: "x.ts"}}, nil); got != nil {
		t.Errorf("nil tokens should return nil, got %v", got)
	}
}

func TestAttachReferencesHappyPath(t *testing.T) {
	app := absTempDir(t)
	mustWriteCtx(t, filepath.Join(app, "hooks", "forms.ts"), "export const form = 1;\nexport const validate = 2;\n")
	mustWriteCtx(t, filepath.Join(app, "lib", "noise.ts"), "export const noise = 1;\n")

	idx := symbol.SymbolIndex{
		Symbols: []symbol.SymbolEntry{
			{Name: "useFormState", File: "hooks/forms.ts"},
			{Name: "FormError", File: "hooks/forms.ts"},
			{Name: "noise", File: "lib/noise.ts"},
		},
	}
	got := memory.AttachReferences("update form validation", idx, memory.AttachOptions{AppPath: app})
	if len(got) != 1 {
		t.Fatalf("want 1 reference, got %d (%+v)", len(got), got)
	}
	if got[0].Rel != "hooks/forms.ts" {
		t.Errorf("rel: got %q", got[0].Rel)
	}
	if got[0].Score < memory.ReferenceMinScore {
		t.Errorf("score %d below min %d", got[0].Score, memory.ReferenceMinScore)
	}
	if !strings.Contains(got[0].Content, "export const form") {
		t.Errorf("content missing expected substring: %q", got[0].Content)
	}
	if got[0].Truncated {
		t.Errorf("small file should not be truncated")
	}
}

func TestAttachReferencesRespectsExcludeAndCap(t *testing.T) {
	app := absTempDir(t)
	for _, name := range []string{"a", "b", "c", "d"} {
		mustWriteCtx(t, filepath.Join(app, "hooks", name+".ts"), "export const "+name+" = 1;\n")
	}
	idx := symbol.SymbolIndex{
		Symbols: []symbol.SymbolEntry{
			{Name: "formA", File: "hooks/a.ts"},
			{Name: "formAlt", File: "hooks/a.ts"},
			{Name: "formB", File: "hooks/b.ts"},
			{Name: "formBis", File: "hooks/b.ts"},
			{Name: "formC", File: "hooks/c.ts"},
			{Name: "formCit", File: "hooks/c.ts"},
			{Name: "formD", File: "hooks/d.ts"},
			{Name: "formDel", File: "hooks/d.ts"},
		},
	}
	// All four files score the same (2 each from the two "form" matches);
	// a.ts goes first by file-path tiebreaker. We exclude it and cap at
	// ReferenceMaxFiles (3).
	got := memory.AttachReferences("form form", idx, memory.AttachOptions{
		AppPath:      app,
		ExcludePaths: []string{"hooks/a.ts"},
	})
	if len(got) != memory.ReferenceMaxFiles {
		t.Fatalf("expected cap of %d, got %d", memory.ReferenceMaxFiles, len(got))
	}
	for _, r := range got {
		if r.Rel == "hooks/a.ts" {
			t.Errorf("excluded path leaked through: %+v", r)
		}
	}
}

func TestAttachReferencesEmptyInputs(t *testing.T) {
	app := absTempDir(t)
	if got := memory.AttachReferences("anything", symbol.SymbolIndex{}, memory.AttachOptions{AppPath: app}); got != nil {
		t.Errorf("empty index should return nil, got %v", got)
	}
	idx := symbol.SymbolIndex{Symbols: []symbol.SymbolEntry{{Name: "x", File: "x.ts"}}}
	if got := memory.AttachReferences("", idx, memory.AttachOptions{AppPath: app}); got != nil {
		t.Errorf("empty body should return nil, got %v", got)
	}
	if got := memory.AttachReferences("form", idx, memory.AttachOptions{AppPath: "relative"}); got != nil {
		t.Errorf("relative app path should return nil, got %v", got)
	}
}

// ---------------------------------------------------------------------
// resume_prompt.go
// ---------------------------------------------------------------------

func TestBuildResumePromptIncludesHeaderBodyAndFooter(t *testing.T) {
	m := meta.Meta{TaskID: "t_20260101_007"}
	out := memory.BuildResumePrompt(m, memory.ResumeOptions{
		Role:            "coder",
		Repo:            "claude-bridge",
		ParentSessionID: "abc-123",
		CoordinatorBody: "Tighten the Tokenize stopword list.",
	})
	for _, want := range []string{
		"Follow-up turn — task `t_20260101_007`",
		"role `coder`",
		"@ `claude-bridge`",
		"Coordinator session: `abc-123`.",
		"Tighten the Tokenize stopword list.",
		"sessions/t_20260101_007/reports/coder-claude-bridge.md",
		"do NOT re-read or re-emit it",
		"do not run `git checkout`",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
}

func TestBuildResumePromptDirectSpawnAndEmptyBody(t *testing.T) {
	m := meta.Meta{TaskID: "t_x"}
	out := memory.BuildResumePrompt(m, memory.ResumeOptions{
		Role:            "reviewer",
		Repo:            "repoX",
		ParentSessionID: "",    // direct spawn branch
		CoordinatorBody: "   ", // whitespace-only body branch
	})
	if !strings.Contains(out, "Coordinator session: (none — direct spawn).") {
		t.Errorf("missing direct-spawn line:\n%s", out)
	}
	if !strings.Contains(out, "(coordinator did not provide a follow-up brief)") {
		t.Errorf("missing empty-body fallback:\n%s", out)
	}
}

// ---------------------------------------------------------------------
// recent_direction.go
// ---------------------------------------------------------------------

func TestPickTouchedDirReturnsParentOfTopFile(t *testing.T) {
	idx := symbol.SymbolIndex{
		Symbols: []symbol.SymbolEntry{
			{Name: "useFormState", File: "hooks/forms.ts"},
			{Name: "FormError", File: "hooks/forms.ts"},
		},
	}
	if got := memory.PickTouchedDir("update the form please", idx); got != "hooks" {
		t.Errorf("got %q, want %q", got, "hooks")
	}
}

func TestPickTouchedDirSkipsRootAndEmpty(t *testing.T) {
	// Top-scoring file at repo root → nothing useful to surface.
	idx := symbol.SymbolIndex{
		Symbols: []symbol.SymbolEntry{
			{Name: "formA", File: "form.ts"},
			{Name: "formB", File: "form.ts"},
		},
	}
	if got := memory.PickTouchedDir("form form", idx); got != "" {
		t.Errorf("repo-root file should yield empty dir, got %q", got)
	}
	if got := memory.PickTouchedDir("anything", symbol.SymbolIndex{}); got != "" {
		t.Errorf("empty index should yield empty dir, got %q", got)
	}
}

func TestLoadRecentDirectionGitMissingOrEmptyDir(t *testing.T) {
	// Empty dir + no auto-pick inputs → zero value, no error.
	got, err := memory.LoadRecentDirection(t.TempDir(), "", memory.RecentOptions{})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if got.Dir != "" || got.Log != "" {
		t.Errorf("expected zero value, got %+v", got)
	}

	// Empty repoCwd with an explicit dir → also zero (we don't run git
	// against the bridge's own cwd as a fallback; the caller must say
	// where to run).
	got, err = memory.LoadRecentDirection("", "hooks", memory.RecentOptions{})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if got.Dir != "" {
		t.Errorf("expected zero value, got %+v", got)
	}
}

func TestLoadRecentDirectionRunsGit(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not on PATH — skipping live-git test")
	}
	repo := t.TempDir()
	mustGit(t, repo, "init", "-q")
	mustGit(t, repo, "config", "user.email", "test@example.com")
	mustGit(t, repo, "config", "user.name", "Test")
	// Disable GPG signing in case the host config requires it; we
	// don't want this test to depend on a signing key.
	mustGit(t, repo, "config", "commit.gpgsign", "false")
	mustWriteCtx(t, filepath.Join(repo, "hooks", "forms.ts"), "export const form = 1;\n")
	mustGit(t, repo, "add", ".")
	mustGit(t, repo, "commit", "-q", "-m", "feat: add form hook")

	got, err := memory.LoadRecentDirection(repo, "hooks", memory.RecentOptions{})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if got.Dir != "hooks" {
		t.Errorf("dir: %q", got.Dir)
	}
	if !strings.Contains(got.Log, "feat: add form hook") {
		t.Errorf("log missing commit subject:\n%s", got.Log)
	}
	if got.Truncated {
		t.Errorf("single commit should not be truncated")
	}
}

// ---------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------

func mustWriteCtx(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", path, err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func mustGit(t *testing.T, cwd string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", cwd}, args...)...)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

func equalStringSlices(a, b []string) bool {
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
