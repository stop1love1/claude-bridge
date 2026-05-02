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

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || (len(s) > len(sub) && (s[:len(sub)] == sub || contains(s[1:], sub))))
}
