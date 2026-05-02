package git

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

// ReadBranch returns the currently checked-out branch for the working
// tree at repoPath, without shelling out to git. Reads .git/HEAD
// directly so a missing git binary doesn't break the sessions list.
//
//   - "ref: refs/heads/<branch>" → branch name
//   - bare SHA → "(detached HEAD)"
//   - .git as a worktree pointer file (`gitdir: <path>`) is followed
//     one level so worktrees show their own HEAD instead of the parent
//     repo's.
//
// Returns ("", false) if the path isn't a git repo. Mirrors
// libs/git.ts readGitBranch exactly.
func ReadBranch(repoPath string) (string, bool) {
	headPath := filepath.Join(repoPath, ".git", "HEAD")
	if _, err := os.Stat(headPath); err != nil {
		// .git might be a file (worktree pointer).
		dotGit := filepath.Join(repoPath, ".git")
		st, err := os.Stat(dotGit)
		if err != nil || st.IsDir() {
			return "", false
		}
		body, err := os.ReadFile(dotGit)
		if err != nil {
			return "", false
		}
		m := worktreeRE.FindStringSubmatch(strings.TrimSpace(string(body)))
		if m == nil {
			return "", false
		}
		target := m[1]
		// Resolve relative gitdir against repoPath. Absolute (POSIX
		// or Windows drive-letter) paths stay as-is.
		if !filepath.IsAbs(target) && !drivePrefixRE.MatchString(target) {
			target = filepath.Join(repoPath, target)
		}
		inner := filepath.Join(target, "HEAD")
		raw, err := os.ReadFile(inner)
		if err != nil {
			return "", false
		}
		return parseHead(string(raw)), true
	}
	body, err := os.ReadFile(headPath)
	if err != nil {
		return "", false
	}
	return parseHead(string(body)), true
}

var (
	worktreeRE    = regexp.MustCompile(`^gitdir:\s*(.+)$`)
	drivePrefixRE = regexp.MustCompile(`^[A-Za-z]:`)
	headRefRE     = regexp.MustCompile(`^ref:\s*refs/heads/(.+)$`)
	shaRE         = regexp.MustCompile(`^[0-9a-fA-F]{7,40}$`)
)

func parseHead(raw string) string {
	text := strings.TrimSpace(raw)
	if m := headRefRE.FindStringSubmatch(text); m != nil {
		return m[1]
	}
	if shaRE.MatchString(text) {
		return "(detached HEAD)"
	}
	return text
}

// BranchMode controls how the bridge picks a branch for a child spawn.
//
//   - Current     → no checkout (the child runs on whatever branch the
//                   working tree currently has).
//   - Fixed       → `git checkout <FixedBranch>`, creating it from HEAD
//                   if missing.
//   - AutoCreate  → `git checkout -b claude/<task-id>`, with a fallback
//                   to plain checkout if the branch already exists.
type BranchMode string

const (
	BranchModeCurrent    BranchMode = "current"
	BranchModeFixed      BranchMode = "fixed"
	BranchModeAutoCreate BranchMode = "auto-create"
)

// Settings is the per-app git lifecycle config that bridge.json carries
// alongside each app entry. The spawn lifecycle hook calls into this
// package with these flags before / after every child run.
type Settings struct {
	BranchMode  BranchMode
	FixedBranch string
	AutoCommit  bool
	AutoPush    bool
}

// PrepareForSpawn runs the BranchMode pre-step against repoPath. taskID
// is required only for AutoCreate (drives the `claude/<task-id>`
// suffix).
//
// Returns the branch name the child will run on. Errors are surfaced
// to the caller; the spawn route logs them and aborts the spawn (a
// child running on the wrong branch would commit to the wrong place).
func PrepareForSpawn(repoPath, taskID string, s Settings) (branch string, err error) {
	switch s.BranchMode {
	case BranchModeCurrent, "":
		// No-op. The child uses whatever branch the working tree has.
		b, _ := ReadBranch(repoPath)
		return b, nil
	case BranchModeFixed:
		if s.FixedBranch == "" {
			return "", errors.New("git: branchMode=fixed requires FixedBranch")
		}
		if err := checkoutOrCreate(repoPath, s.FixedBranch); err != nil {
			return "", err
		}
		return s.FixedBranch, nil
	case BranchModeAutoCreate:
		branch := "claude/" + taskID
		if err := checkoutOrCreate(repoPath, branch); err != nil {
			return "", err
		}
		return branch, nil
	default:
		return "", fmt.Errorf("git: unknown branchMode %q", s.BranchMode)
	}
}

// AfterSpawn runs the post-spawn AutoCommit / AutoPush steps. Failures
// are returned but the caller (lifecycle hook) treats them as
// best-effort: a failed commit/push must NOT flip a successful run to
// failed — the operator can retry manually.
func AfterSpawn(repoPath, message string, s Settings) error {
	if !s.AutoCommit && !s.AutoPush {
		return nil
	}
	if s.AutoCommit {
		if err := run(repoPath, "git", "add", "-A"); err != nil {
			return fmt.Errorf("git add: %w", err)
		}
		// Allow empty: the bridge runs commit even when nothing changed
		// so the autoPush step has something to push (no-op push otherwise).
		if err := run(repoPath, "git", "commit", "--allow-empty", "-m", message); err != nil {
			return fmt.Errorf("git commit: %w", err)
		}
	}
	if s.AutoPush {
		if err := run(repoPath, "git", "push"); err != nil {
			return fmt.Errorf("git push: %w", err)
		}
	}
	return nil
}

// checkoutOrCreate runs `git checkout <branch>` and falls back to
// `git checkout -b <branch>` on failure (the branch doesn't exist yet).
// Mirrors the BranchMode=fixed / auto-create semantics.
func checkoutOrCreate(repoPath, branch string) error {
	if err := run(repoPath, "git", "checkout", branch); err == nil {
		return nil
	}
	return run(repoPath, "git", "checkout", "-b", branch)
}

// run shells out to a command in repoPath. stdout/stderr are captured
// and surfaced via the returned error so failures are diagnosable.
func run(dir, name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s %s: %w (%s)", name, strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}
