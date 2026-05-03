package git_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/stop1love1/claude-bridge/internal/git"
)

// requireGit skips the test when a git binary isn't on PATH (CI
// containers without git).
func requireGit(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skipf("git not on PATH: %v", err)
	}
}

func initRepo(t *testing.T) string {
	t.Helper()
	requireGit(t)
	dir := t.TempDir()
	for _, args := range [][]string{
		{"init", "-q", "-b", "main"},
		{"config", "user.email", "test@example.com"},
		{"config", "user.name", "Test"},
		{"commit", "--allow-empty", "-m", "init"},
	} {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, string(out))
		}
	}
	return dir
}

func TestReadBranchOnFreshRepo(t *testing.T) {
	dir := initRepo(t)
	b, ok := git.ReadBranch(dir)
	if !ok {
		t.Fatal("ReadBranch returned ok=false on a real repo")
	}
	if b != "main" {
		t.Errorf("branch: got %q, want main", b)
	}
}

func TestReadBranchOnDetachedHead(t *testing.T) {
	dir := initRepo(t)
	// Resolve current SHA, then `git checkout <sha>` to detach.
	out, err := exec.Command("git", "-C", dir, "rev-parse", "HEAD").CombinedOutput()
	if err != nil {
		t.Fatalf("rev-parse: %v: %s", err, string(out))
	}
	sha := string(out)
	cmd := exec.Command("git", "-C", dir, "checkout", "--detach", sha[:7])
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("checkout detach: %v: %s", err, string(out))
	}
	b, ok := git.ReadBranch(dir)
	if !ok {
		t.Fatal("ReadBranch returned ok=false")
	}
	if b != "(detached HEAD)" {
		t.Errorf("branch: got %q, want (detached HEAD)", b)
	}
}

func TestReadBranchOnNonGitDir(t *testing.T) {
	dir := t.TempDir()
	_, ok := git.ReadBranch(dir)
	if ok {
		t.Error("expected ok=false on non-git dir")
	}
}

func TestPrepareForSpawnCurrentNoOp(t *testing.T) {
	dir := initRepo(t)
	b, err := git.PrepareForSpawn(dir, "t_20260101_001", git.Settings{BranchMode: git.BranchModeCurrent})
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	if b != "main" {
		t.Errorf("branch: got %q, want main (current)", b)
	}
}

func TestPrepareForSpawnAutoCreateMakesNewBranch(t *testing.T) {
	dir := initRepo(t)
	b, err := git.PrepareForSpawn(dir, "t_20260101_001", git.Settings{BranchMode: git.BranchModeAutoCreate})
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	if b != "claude/t_20260101_001" {
		t.Errorf("branch: got %q, want claude/t_20260101_001", b)
	}
	got, _ := git.ReadBranch(dir)
	if got != "claude/t_20260101_001" {
		t.Errorf("post-checkout branch: got %q", got)
	}
}

func TestPrepareForSpawnFixedBranchRequiresName(t *testing.T) {
	dir := initRepo(t)
	_, err := git.PrepareForSpawn(dir, "t_20260101_001", git.Settings{BranchMode: git.BranchModeFixed})
	if err == nil {
		t.Error("expected error when FixedBranch is empty")
	}
}

func TestPrepareForSpawnFixedCheckoutCreatesIfMissing(t *testing.T) {
	dir := initRepo(t)
	b, err := git.PrepareForSpawn(dir, "ignored", git.Settings{
		BranchMode:  git.BranchModeFixed,
		FixedBranch: "feature/test",
	})
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	if b != "feature/test" {
		t.Errorf("branch: got %q", b)
	}
}

func TestAfterSpawnCommitsWhenAutoCommitOn(t *testing.T) {
	dir := initRepo(t)
	// Touch a file so the commit isn't empty; but --allow-empty in
	// AfterSpawn means even no-change calls produce a commit.
	if err := os.WriteFile(filepath.Join(dir, "x.txt"), []byte("hi"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := git.AfterSpawn(dir, "test commit", git.Settings{AutoCommit: true}); err != nil {
		t.Fatalf("AfterSpawn: %v", err)
	}
	out, err := exec.Command("git", "-C", dir, "log", "--oneline").CombinedOutput()
	if err != nil {
		t.Fatalf("git log: %v: %s", err, string(out))
	}
	if len(out) == 0 || !contains(string(out), "test commit") {
		t.Errorf("git log missing commit: %s", string(out))
	}
}

func TestAfterSpawnNoOpWhenBothFlagsOff(t *testing.T) {
	dir := initRepo(t)
	if err := git.AfterSpawn(dir, "msg", git.Settings{}); err != nil {
		t.Errorf("AfterSpawn: %v", err)
	}
}

// TestPrepareForSpawnFixedRejectsOptionLikeBranch — a fixedBranch
// value that begins with `-` would be parsed by git as a CLI option.
// PrepareForSpawn must reject before any exec ever happens, regardless
// of whether the upstream apps validator was bypassed (a hand-edited
// bridge.json, a corrupted profile, etc.).
func TestPrepareForSpawnFixedRejectsOptionLikeBranch(t *testing.T) {
	dir := initRepo(t)
	cases := []string{
		"--upload-pack=evil",
		"-c core.editor=evil",
		"-Hsomething",
	}
	for _, name := range cases {
		_, err := git.PrepareForSpawn(dir, "t_20260101_001", git.Settings{
			BranchMode:  git.BranchModeFixed,
			FixedBranch: name,
		})
		if err == nil {
			t.Errorf("FixedBranch %q: expected validation error, got nil", name)
			continue
		}
		// The error message must NOT echo the rejected input back —
		// these strings end up in HTTP responses, and operator-controlled
		// JSON shouldn't be reflected in error messages verbatim.
		if contains(err.Error(), name) {
			t.Errorf("FixedBranch %q: error %q leaks input back to caller", name, err.Error())
		}
	}
}

// TestPrepareForSpawnFixedRejectsTraversal — `..` segments would let
// the operator address parent refs (`refs/heads/../../etc`). The
// validator's regex denies the dot-dot pair regardless of where it
// appears in the string.
func TestPrepareForSpawnFixedRejectsTraversal(t *testing.T) {
	dir := initRepo(t)
	_, err := git.PrepareForSpawn(dir, "t_20260101_001", git.Settings{
		BranchMode:  git.BranchModeFixed,
		FixedBranch: "feature/..",
	})
	if err == nil {
		t.Error("expected error for branch with `..` segment, got nil")
	}
}

// TestPrepareForSpawnFixedRejectsControlChars — whitespace and NUL
// bytes have no place in a branch ref; git would either reject them
// or, worse, accept them in some refs/heads/ subpath. Validate up front.
func TestPrepareForSpawnFixedRejectsControlChars(t *testing.T) {
	dir := initRepo(t)
	cases := []string{
		"feature\nbranch",
		"feature\x00branch",
		"feature branch",
	}
	for _, name := range cases {
		_, err := git.PrepareForSpawn(dir, "t_20260101_001", git.Settings{
			BranchMode:  git.BranchModeFixed,
			FixedBranch: name,
		})
		if err == nil {
			t.Errorf("FixedBranch with control chars %q: expected error", name)
		}
	}
}

// TestPrepareForSpawnFixedAcceptsValidBranches — the validator must
// not regress on legitimate branch names that exist in the wild.
func TestPrepareForSpawnFixedAcceptsValidBranches(t *testing.T) {
	for _, name := range []string{
		"main",
		"feature/foo-bar",
		"release/v1.2.3",
		"user/jane.doe/wip",
		"hotfix-2024-01",
	} {
		dir := initRepo(t)
		got, err := git.PrepareForSpawn(dir, "t_20260101_001", git.Settings{
			BranchMode:  git.BranchModeFixed,
			FixedBranch: name,
		})
		if err != nil {
			t.Errorf("FixedBranch %q: unexpected validation error: %v", name, err)
			continue
		}
		if got != name {
			t.Errorf("FixedBranch %q: got %q", name, got)
		}
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || (len(s) > len(sub) && (s[:len(sub)] == sub || contains(s[1:], sub))))
}
