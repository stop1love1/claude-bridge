package git_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stop1love1/claude-bridge/internal/git"
	"github.com/stop1love1/claude-bridge/internal/meta"
)

// runGit is a shorthand for the test-only "fail loudly on git errors"
// helper. The bridge's Settings/lifecycle code uses CombinedOutput;
// here we want the same diagnostic surface when seeding test repos.
func runGit(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v: %s", args, err, string(out))
	}
}

func TestCreateWorktreeForRunHappyPath(t *testing.T) {
	repo := initRepo(t)
	const sid = "abc-123"

	wt, err := git.CreateWorktreeForRun(repo, sid, "main")
	if err != nil {
		t.Fatalf("CreateWorktreeForRun: %v", err)
	}
	if wt.BaseBranch != "main" {
		t.Errorf("BaseBranch: got %q, want main", wt.BaseBranch)
	}
	if wt.Branch != "claude/wt/abc-123" {
		t.Errorf("Branch: got %q, want claude/wt/abc-123", wt.Branch)
	}
	want := filepath.Join(repo, ".worktrees", sid)
	if wt.Path != want {
		t.Errorf("Path: got %q, want %q", wt.Path, want)
	}
	// `git worktree add` must have actually created the dir AND
	// registered the branch — verify both rather than trusting the
	// no-error return.
	if st, err := os.Stat(wt.Path); err != nil || !st.IsDir() {
		t.Errorf("worktree dir: stat=%v err=%v", st, err)
	}
	got, ok := readBranchAt(t, wt.Path)
	if !ok || got != wt.Branch {
		t.Errorf("worktree HEAD: got %q ok=%v, want %q", got, ok, wt.Branch)
	}
}

func TestCreateWorktreeForRunEmptyBaseUsesHEAD(t *testing.T) {
	repo := initRepo(t)
	// Live tree is on main; passing "" should fall back to current
	// HEAD (main) so BaseBranch comes back populated, not blank.
	wt, err := git.CreateWorktreeForRun(repo, "sid-1", "")
	if err != nil {
		t.Fatalf("CreateWorktreeForRun: %v", err)
	}
	if wt.BaseBranch != "main" {
		t.Errorf("BaseBranch fallback: got %q, want main", wt.BaseBranch)
	}
}

func TestCreateWorktreeForRunRefusesNonAbsolute(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skipf("git not on PATH: %v", err)
	}
	if _, err := git.CreateWorktreeForRun("relative/path", "sid", ""); err == nil {
		t.Error("expected error on non-absolute appRoot")
	}
}

func TestCreateWorktreeForRunRequiresSessionID(t *testing.T) {
	repo := initRepo(t)
	if _, err := git.CreateWorktreeForRun(repo, "", "main"); err == nil {
		t.Error("expected error on empty sessionID")
	}
}

func TestCreateWorktreeForRunRefusesNonRepo(t *testing.T) {
	requireGit(t)
	dir := t.TempDir()
	if _, err := git.CreateWorktreeForRun(dir, "sid", ""); err == nil {
		t.Error("expected error when appRoot is not a git repo")
	}
}

func TestCreateWorktreeForRunRefusesExistingPath(t *testing.T) {
	repo := initRepo(t)
	const sid = "dup"
	// Plant a stale dir at the target path to simulate a crashed
	// prior spawn — CreateWorktreeForRun must refuse rather than
	// hand the existing dir to git and getting a cryptic error.
	stale := filepath.Join(repo, ".worktrees", sid)
	if err := os.MkdirAll(stale, 0o755); err != nil {
		t.Fatalf("seed stale dir: %v", err)
	}
	if _, err := git.CreateWorktreeForRun(repo, sid, ""); err == nil {
		t.Error("expected error when target path already exists")
	}
}

func TestRemoveWorktreeHappyPath(t *testing.T) {
	repo := initRepo(t)
	const sid = "rm-1"
	wt, err := git.CreateWorktreeForRun(repo, sid, "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := git.RemoveWorktree(repo, sid); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if _, err := os.Stat(wt.Path); !os.IsNotExist(err) {
		t.Errorf("expected worktree dir gone, stat err=%v", err)
	}
	// Registration must also be cleared — `git worktree list` should
	// no longer mention the path.
	out, err := exec.Command("git", "-C", repo, "worktree", "list", "--porcelain").CombinedOutput()
	if err != nil {
		t.Fatalf("worktree list: %v: %s", err, string(out))
	}
	if strings.Contains(string(out), wt.Path) {
		t.Errorf("worktree list still references %q:\n%s", wt.Path, string(out))
	}
}

func TestRemoveWorktreeIdempotentWhenMissing(t *testing.T) {
	repo := initRepo(t)
	// Never created — Remove must not error.
	if err := git.RemoveWorktree(repo, "never-existed"); err != nil {
		t.Errorf("Remove on missing: %v", err)
	}
}

func TestMergeWorktreeBackHappyPath(t *testing.T) {
	repo := initRepo(t)
	wt, err := git.CreateWorktreeForRun(repo, "merge-1", "main")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	// Author a commit inside the worktree so the merge has something
	// to land. Without this the merge would be a no-op.
	writeAndCommit(t, wt.Path, "feature.txt", "from worktree", "feat: add file")

	outcome, err := git.MergeWorktreeBack(repo, wt)
	if err != nil {
		t.Fatalf("MergeWorktreeBack: %v", err)
	}
	if !outcome.Merged || outcome.Conflict {
		t.Fatalf("outcome: %+v", outcome)
	}
	// The merged file must now be present in the live tree.
	if _, err := os.Stat(filepath.Join(repo, "feature.txt")); err != nil {
		t.Errorf("merged file missing in live tree: %v", err)
	}

	// Cleanup leaves the worktree behind by contract — MergeWorktreeBack
	// only handles the merge. Verify the dir still exists, then remove.
	if _, err := os.Stat(wt.Path); err != nil {
		t.Errorf("worktree dir should remain after merge, stat err=%v", err)
	}
	if err := git.RemoveWorktree(repo, "merge-1"); err != nil {
		t.Errorf("Remove post-merge: %v", err)
	}
}

func TestMergeWorktreeBackSkipsWithoutBaseBranch(t *testing.T) {
	requireGit(t)
	// No filesystem operations — pure logic check that the early
	// return doesn't shell out and doesn't error.
	out, err := git.MergeWorktreeBack("", git.Worktree{Branch: "x", BaseBranch: ""})
	if err != nil {
		t.Errorf("err: %v", err)
	}
	if out.Merged || out.Conflict {
		t.Errorf("outcome should be inert: %+v", out)
	}
}

func TestMergeWorktreeBackSkipsWhenBranchEqualsBase(t *testing.T) {
	requireGit(t)
	out, err := git.MergeWorktreeBack("", git.Worktree{Branch: "main", BaseBranch: "main"})
	if err != nil {
		t.Errorf("err: %v", err)
	}
	if out.Merged || out.Conflict {
		t.Errorf("outcome should be inert: %+v", out)
	}
}

func TestMergeWorktreeBackConflictAborts(t *testing.T) {
	repo := initRepo(t)
	// Seed a baseline file on main so both sides can diverge from
	// the same blob.
	writeAndCommit(t, repo, "shared.txt", "base\n", "init shared")

	wt, err := git.CreateWorktreeForRun(repo, "conflict-1", "main")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	// Diverge: live tree edits shared.txt one way…
	writeAndCommit(t, repo, "shared.txt", "live edit\n", "live: edit shared")
	// …while the worktree edits it another way.
	writeAndCommit(t, wt.Path, "shared.txt", "worktree edit\n", "wt: edit shared")

	outcome, err := git.MergeWorktreeBack(repo, wt)
	if err != nil {
		t.Fatalf("MergeWorktreeBack: %v", err)
	}
	if outcome.Merged {
		t.Errorf("expected Merged=false on conflict, got %+v", outcome)
	}
	if !outcome.Conflict {
		t.Errorf("expected Conflict=true, got %+v", outcome)
	}
	// The merge --abort must have cleared the in-progress merge
	// state. We check for MERGE_HEAD rather than `status --porcelain`
	// because the latter also reports the .worktrees/ dir as
	// untracked, which is expected and unrelated to the abort.
	if _, err := os.Stat(filepath.Join(repo, ".git", "MERGE_HEAD")); !os.IsNotExist(err) {
		t.Errorf("expected MERGE_HEAD gone after abort, stat err=%v", err)
	}
	// Worktree branch must still exist for manual recovery.
	br, err := exec.Command("git", "-C", repo, "branch", "--list", wt.Branch).CombinedOutput()
	if err != nil {
		t.Fatalf("branch list: %v: %s", err, string(br))
	}
	if !strings.Contains(string(br), wt.Branch) {
		t.Errorf("worktree branch should be retained after conflict, got: %s", string(br))
	}
}

func TestListWorktreesIncludesCreated(t *testing.T) {
	repo := initRepo(t)
	wt, err := git.CreateWorktreeForRun(repo, "list-1", "")
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	defer func() { _ = git.RemoveWorktree(repo, "list-1") }()

	list, err := git.ListWorktrees(repo)
	if err != nil {
		t.Fatalf("ListWorktrees: %v", err)
	}
	// At minimum: the live tree + the one we just created.
	if len(list) < 2 {
		t.Fatalf("expected >=2 entries, got %d: %+v", len(list), list)
	}
	// `git worktree list` emits forward-slash paths on Windows AND
	// may return the long-form vs short-form (8.3) variant of the
	// tempdir, so direct path equality is unreliable. The portable
	// signal is the suffix we actually care about — every created
	// worktree lives under `.worktrees/<sessionID>` relative to the
	// app root. Match on that.
	wantSuffix := filepath.ToSlash(filepath.Join(".worktrees", "list-1"))
	var found bool
	for _, w := range list {
		norm := filepath.ToSlash(filepath.Clean(w.Path))
		if strings.HasSuffix(norm, wantSuffix) {
			found = true
			if w.Branch != wt.Branch {
				t.Errorf("listed branch: got %q, want %q", w.Branch, wt.Branch)
			}
		}
	}
	if !found {
		t.Errorf("created worktree not in list: %+v", list)
	}
}

func TestInheritWorktreeFieldsCopiesPointers(t *testing.T) {
	p, b, bb := "wt/path", "claude/wt/sid", "main"
	parent := meta.Run{
		WorktreePath:       &p,
		WorktreeBranch:     &b,
		WorktreeBaseBranch: &bb,
	}
	gotP, gotB, gotBB := git.InheritWorktreeFields(parent)
	if gotP != &p || gotB != &b || gotBB != &bb {
		t.Errorf("expected pointer parity; got %p,%p,%p", gotP, gotB, gotBB)
	}
}

func TestInheritWorktreeFieldsNilWhenAbsent(t *testing.T) {
	gotP, gotB, gotBB := git.InheritWorktreeFields(meta.Run{})
	if gotP != nil || gotB != nil || gotBB != nil {
		t.Errorf("expected all nil; got %v,%v,%v", gotP, gotB, gotBB)
	}
}

// TestCreateWorktreeForRunRejectsOptionLikeBaseBranch — baseBranch
// rides into `git worktree add` as the trailing positional arg. A
// `-c core.editor=...` value would be parsed as an option, allowing
// arbitrary git config injection. Validate before exec.
func TestCreateWorktreeForRunRejectsOptionLikeBaseBranch(t *testing.T) {
	repo := initRepo(t)
	for _, name := range []string{
		"--upload-pack=evil",
		"-c core.editor=evil",
		"--exec=evil",
	} {
		_, err := git.CreateWorktreeForRun(repo, "sid-evil", name)
		if err == nil {
			t.Errorf("baseBranch %q: expected validation error, got nil", name)
		}
	}
}

// TestMergeWorktreeBackRejectsOptionLikeBranches — both BaseBranch
// and Branch would otherwise be passed verbatim to `git checkout` /
// `git merge`. Validation must short-circuit before any exec.
func TestMergeWorktreeBackRejectsOptionLikeBranches(t *testing.T) {
	requireGit(t)
	cases := []git.Worktree{
		{Branch: "feature", BaseBranch: "--upload-pack=evil"},
		{Branch: "-c core.editor=evil", BaseBranch: "main"},
		{Branch: "feature", BaseBranch: "feature/.."},
	}
	for _, w := range cases {
		_, err := git.MergeWorktreeBack("/nonexistent", w)
		if err == nil {
			t.Errorf("MergeWorktreeBack(%+v): expected validation error", w)
		}
	}
}

// readBranchAt re-reads HEAD inside a worktree the same way the
// production ReadBranch does — but tests live in the _test package
// and we only need the branch name, so a small inline impl is
// cleaner than wiring through the full ReadBranch machinery.
func readBranchAt(t *testing.T, dir string) (string, bool) {
	t.Helper()
	out, err := exec.Command("git", "-C", dir, "rev-parse", "--abbrev-ref", "HEAD").CombinedOutput()
	if err != nil {
		t.Logf("rev-parse: %v: %s", err, string(out))
		return "", false
	}
	name := strings.TrimSpace(string(out))
	return name, name != "" && name != "HEAD"
}

// writeAndCommit drops a file at dir/name with the given body, then
// `git add` + `git commit -m`s it. Used to seed both the live tree
// and the worktree with diverging history.
func writeAndCommit(t *testing.T, dir, name, body, msg string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
	runGit(t, dir, "add", name)
	runGit(t, dir, "commit", "-m", msg)
}
