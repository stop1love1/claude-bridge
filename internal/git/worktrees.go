package git

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/stop1love1/claude-bridge/internal/meta"
	"github.com/stop1love1/claude-bridge/internal/pathsafe"
)

// worktreesDirName is the per-app folder that holds every spawn's
// private worktree. Kept under the app root so a sibling tool that
// scans for ".git" subtrees finds one parent per worktree, not a
// global pool.
const worktreesDirName = ".worktrees"

// worktreeBranchPrefix mints branches in their own namespace so a
// reviewer scanning `git branch` can tell bridge-spawned branches from
// human-authored ones at a glance. The `wt/` infix distinguishes
// worktree-isolated runs from the `claude/<task-id>` branches the
// auto-create lifecycle hook produces.
const worktreeBranchPrefix = "claude/wt/"

// Worktree describes a per-spawn isolated checkout. The three fields
// match the optional pointer fields meta.Run carries (WorktreePath,
// WorktreeBranch, WorktreeBaseBranch) so the lifecycle hook can move
// them between Worktree values and meta.json without re-deriving.
//
// BaseBranch is empty when the worktree was forked from a detached
// HEAD or a fresh repo; MergeWorktreeBack treats that as "skip merge,
// just remove" so we never try to merge into an unnamed ref.
type Worktree struct {
	Path       string
	Branch     string
	BaseBranch string
}

// MergeOutcome is the structured result of MergeWorktreeBack. Conflict
// is split out from Merged so a caller can distinguish "we tried and
// the merge produced conflicts" (worktree branch retained for manual
// recovery) from "we never tried because there was nothing to merge".
type MergeOutcome struct {
	Merged   bool
	Conflict bool
	Message  string
}

// CreateWorktreeForRun allocates `<appRoot>/.worktrees/<sessionID>/`
// and runs `git worktree add -b <branch> <path> [<baseBranch>]`. When
// baseBranch is empty the new branch forks from the live tree's
// current HEAD — same effect as omitting <start-point> from the git
// CLI. The worktree branch is always per-session unique
// (`claude/wt/<sanitized-sessionID>`) so concurrent spawns can never
// collide on the branch name.
//
// Returns an error rather than nil-handle so the lifecycle hook can
// log the underlying git failure. Callers that want fail-soft
// behaviour (fall back to spawning in the live tree) should swallow
// the error themselves — the bridge logs but does not abort spawn.
func CreateWorktreeForRun(appRoot, sessionID, baseBranch string) (Worktree, error) {
	if !filepath.IsAbs(appRoot) {
		return Worktree{}, fmt.Errorf("worktree: appRoot must be absolute, got %q", appRoot)
	}
	if sessionID == "" {
		return Worktree{}, errors.New("worktree: sessionID required")
	}
	if _, err := os.Stat(filepath.Join(appRoot, ".git")); err != nil {
		return Worktree{}, fmt.Errorf("worktree: %s is not a git repo: %w", appRoot, err)
	}
	// baseBranch (when supplied) ends up as a positional arg to
	// `git worktree add`. Reject anything that could be interpreted as
	// a CLI option before the validator inside `git` ever sees it.
	if baseBranch != "" {
		if err := validateBranchName(baseBranch); err != nil {
			return Worktree{}, fmt.Errorf("worktree: invalid base branch: %w", err)
		}
	}

	wtPath := worktreePathFor(appRoot, sessionID)
	if !isUnderAppRoot(appRoot, wtPath) {
		return Worktree{}, fmt.Errorf("worktree: refusing to create path outside app root: %q", wtPath)
	}

	// Ensure `<appRoot>/.worktrees/` exists before `git worktree add`.
	// On Windows a missing intermediate dir trips the add with a
	// confusing message; mkdir -p semantics here keep the failure
	// surface clean.
	if err := os.MkdirAll(filepath.Join(appRoot, worktreesDirName), 0o755); err != nil {
		return Worktree{}, fmt.Errorf("worktree: mkdir parent: %w", err)
	}
	// A leftover dir from a crashed prior spawn would make `git
	// worktree add` fail with a cryptic "already exists". Refuse
	// up front so the caller's log line points at the real cause.
	if _, err := os.Stat(wtPath); err == nil {
		return Worktree{}, fmt.Errorf("worktree: target path already exists: %q", wtPath)
	}

	resolvedBase := baseBranch
	if resolvedBase == "" {
		// Empty baseBranch → fork from current HEAD. We resolve the
		// branch name (rather than letting git default to HEAD) so the
		// returned Worktree.BaseBranch carries an explicit name when
		// one exists; merge-back needs a named ref.
		if b, ok := currentBranchOf(appRoot); ok {
			resolvedBase = b
		}
	}

	branch := mintWorktreeBranch(sessionID)
	// mintWorktreeBranch sanitizes through sanitizeBranchSegment, but we
	// re-validate anyway: a future change to that helper that accidentally
	// allows a leading dash would otherwise produce a branch name that
	// `git` parses as an option.
	if err := validateBranchName(branch); err != nil {
		return Worktree{}, fmt.Errorf("worktree: minted branch invalid: %w", err)
	}
	args := []string{"worktree", "add", "-b", branch, wtPath}
	if resolvedBase != "" {
		args = append(args, resolvedBase)
	}
	if err := run(appRoot, "git", args...); err != nil {
		// `git worktree add` can leave a half-registered entry behind
		// when it errors after cloning the metadata but before the
		// checkout finishes. Prune so a retry with the same sessionID
		// (after the operator clears the leftover dir) doesn't trip
		// over the stale registration.
		_ = run(appRoot, "git", "worktree", "prune")
		return Worktree{}, fmt.Errorf("worktree: add: %w", err)
	}
	return Worktree{Path: wtPath, Branch: branch, BaseBranch: resolvedBase}, nil
}

// RemoveWorktree runs `git worktree remove --force <path>` then falls
// back to RemoveAll on the directory if git couldn't clean it (Windows
// file-handle locks from the agent's still-flushing .jsonl writer are
// the usual culprit). A final `git worktree prune` mops up the
// registration so `git worktree list` doesn't keep showing the
// removed entry as "prunable".
//
// Idempotent: missing directory returns nil after pruning the
// registration, so a double-remove from retry logic is harmless.
func RemoveWorktree(appRoot, sessionID string) error {
	wtPath := worktreePathFor(appRoot, sessionID)
	if !isUnderAppRoot(appRoot, wtPath) {
		return fmt.Errorf("worktree: refusing to remove path outside app root: %q", wtPath)
	}
	if _, err := os.Stat(wtPath); errors.Is(err, os.ErrNotExist) {
		_ = run(appRoot, "git", "worktree", "prune")
		return nil
	}
	if err := run(appRoot, "git", "worktree", "remove", "--force", wtPath); err == nil {
		return nil
	}
	// Windows fallback: git refused (locked file), so do the unlink
	// ourselves and let prune drop the orphaned registration.
	if err := os.RemoveAll(wtPath); err != nil {
		return fmt.Errorf("worktree: rm fallback: %w", err)
	}
	_ = run(appRoot, "git", "worktree", "prune")
	return nil
}

// MergeWorktreeBack checks out the worktree's BaseBranch in the live
// tree and runs `git merge --no-ff --no-edit <branch>`. The merge runs
// in the live app tree (not in the worktree itself) because git
// refuses to operate on a branch that's checked out in another
// worktree.
//
// On conflict, aborts the merge and returns Outcome{Conflict: true}
// with the worktree left intact so the operator can resolve manually
// and remove it later. On a clean merge the caller is responsible for
// invoking RemoveWorktree — keeping the steps separate lets the
// coordinator decide whether to preserve a worktree for inspection
// even after a successful merge.
//
// Returns Outcome{Merged: false, Conflict: false} when there's
// nothing to merge (no BaseBranch, or BaseBranch == Branch — the
// latter happens when settings.fixedBranch matched the live HEAD and
// commits already landed on the right ref from inside the worktree).
func MergeWorktreeBack(appRoot string, w Worktree) (MergeOutcome, error) {
	if w.BaseBranch == "" {
		return MergeOutcome{Message: "no base branch; nothing to merge"}, nil
	}
	if w.BaseBranch == w.Branch {
		return MergeOutcome{Message: "base branch equals worktree branch; nothing to merge"}, nil
	}
	// Both branch names ride into git argv; validate before exec so a
	// crafted Worktree literal (or stale meta.json hand-edit) can't turn
	// `BaseBranch="--upload-pack=evil"` into a git option.
	if err := validateBranchName(w.BaseBranch); err != nil {
		return MergeOutcome{}, fmt.Errorf("worktree: invalid base branch: %w", err)
	}
	if err := validateBranchName(w.Branch); err != nil {
		return MergeOutcome{}, fmt.Errorf("worktree: invalid branch: %w", err)
	}

	// Switch the live tree to the merge target. We don't restore the
	// previous branch on exit — the bridge's per-app branchMode hook
	// is what governs the live tree's checked-out branch, not this
	// merge step.
	if cur, ok := currentBranchOf(appRoot); !ok || cur != w.BaseBranch {
		if err := run(appRoot, "git", "checkout", w.BaseBranch); err != nil {
			return MergeOutcome{}, fmt.Errorf("worktree: checkout base failed: %w", err)
		}
	}

	// --no-ff preserves the merge commit even when fast-forwarding
	// would suffice; the audit trail of "this work came from a bridge
	// worktree" is the whole reason this branch exists. The trailing
	// `--` lets git distinguish the branch token from any pathspec git
	// might otherwise look for, even if validateBranchName were ever
	// loosened.
	mergeErr := run(appRoot, "git", "merge", "--no-ff", "--no-edit", w.Branch)
	if mergeErr == nil {
		return MergeOutcome{
			Merged:  true,
			Message: fmt.Sprintf("merged %s into %s", w.Branch, w.BaseBranch),
		}, nil
	}
	// Conflict path: abort so the live tree returns to a clean state
	// and the operator picks up the worktree branch by hand.
	_ = run(appRoot, "git", "merge", "--abort")
	return MergeOutcome{
		Conflict: true,
		Message:  fmt.Sprintf("merge of %s into %s conflicted; worktree retained", w.Branch, w.BaseBranch),
	}, nil
}

// ListWorktrees parses `git worktree list --porcelain` and returns
// every registered worktree under appRoot. The porcelain format is a
// stable contract since git 2.7 — each entry is a sequence of
// "<key> <value>" lines terminated by a blank line. We surface only
// the path / branch / detached marker (encoded as empty Branch).
//
// BaseBranch is left empty in the returned values: porcelain doesn't
// record the fork point, and re-deriving it would require a
// merge-base scan per entry that's nowhere near the cost callers are
// willing to pay for what is, in practice, a registry view.
func ListWorktrees(appRoot string) ([]Worktree, error) {
	if _, err := exec.LookPath("git"); err != nil {
		return nil, fmt.Errorf("worktree: git not on PATH: %w", err)
	}
	cmd := exec.Command("git", "worktree", "list", "--porcelain")
	cmd.Dir = appRoot
	out, err := cmd.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("worktree: list: %w (%s)", err, strings.TrimSpace(string(out)))
	}

	var (
		results []Worktree
		cur     Worktree
		hasCur  bool
	)
	flush := func() {
		if hasCur {
			results = append(results, cur)
		}
		cur = Worktree{}
		hasCur = false
	}
	scanner := bufio.NewScanner(strings.NewReader(string(out)))
	scanner.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			flush()
			continue
		}
		key, val, _ := strings.Cut(line, " ")
		switch key {
		case "worktree":
			cur.Path = val
			hasCur = true
		case "branch":
			// Porcelain emits the full ref ("refs/heads/main"); strip
			// the prefix so callers can compare against branch names
			// they already have without re-parsing.
			cur.Branch = strings.TrimPrefix(val, "refs/heads/")
		case "detached":
			cur.Branch = ""
		}
	}
	flush()
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("worktree: parse list: %w", err)
	}
	return results, nil
}

// InheritWorktreeFields pulls the three worktree pointer fields off a
// parent run so a retry spawn can inherit them. A retry MUST run in
// the same worktree as the run it's retrying — otherwise it would
// spawn in the live tree, miss the parent's WIP edits, and silently
// duplicate work onto a different branch. Returns three nil pointers
// when the parent didn't run in a worktree, so callers can copy them
// into the child run unconditionally.
func InheritWorktreeFields(parent meta.Run) (path, branch, baseBranch *string) {
	return parent.WorktreePath, parent.WorktreeBranch, parent.WorktreeBaseBranch
}

// worktreePathFor returns the canonical per-session worktree dir.
// Exposed (lowercase) so package-internal callers stay in sync with
// CreateWorktreeForRun without hand-concatenating path segments.
func worktreePathFor(appRoot, sessionID string) string {
	return filepath.Join(appRoot, worktreesDirName, sessionID)
}

// isUnderAppRoot is defense-in-depth: even if a caller passes a
// crafted sessionID with `..` segments, RemoveWorktree must never
// `RemoveAll` something outside the app tree. The sessionID is
// validated upstream as a UUID, so this is layered paranoia.
//
// Strict descendant only — equal-to-root counts as "not under" so
// RemoveAll can never target the entire app tree. pathsafe.ContainsStrict
// encodes that policy.
func isUnderAppRoot(appRoot, candidate string) bool {
	return pathsafe.ContainsStrict(appRoot, candidate)
}

// currentBranchOf resolves the working tree's current branch via
// `git rev-parse --abbrev-ref HEAD`. Returns ok=false on detached
// HEAD or any rev-parse error so callers can fall through (worktree
// forks from HEAD without a named base, merge-back is skipped).
//
// The output is treated as untrusted: git's stdout for a corrupted
// HEAD ref could in principle contain anything, and the value flows
// back into git argv via Worktree.BaseBranch. We run it through
// validateBranchName before declaring it usable; failures fall back to
// ok=false (same as detached-HEAD handling).
func currentBranchOf(repoPath string) (string, bool) {
	cmd := exec.Command("git", "rev-parse", "--abbrev-ref", "HEAD")
	cmd.Dir = repoPath
	out, err := cmd.Output()
	if err != nil {
		return "", false
	}
	name := strings.TrimSpace(string(out))
	if name == "" || name == "HEAD" {
		return "", false
	}
	if err := validateBranchName(name); err != nil {
		return "", false
	}
	return name, true
}

// mintWorktreeBranch builds the per-session branch name. The session
// ID is sanitized through sanitizeBranchSegment so any odd characters
// (uppercase, spaces, weirdness from a non-UUID test input) collapse
// to the bridge's canonical charset before they become a ref name.
func mintWorktreeBranch(sessionID string) string {
	return worktreeBranchPrefix + sanitizeBranchSegment(sessionID)
}

// sanitizeBranchSegment lowercases and restricts a segment to the
// bridge's branch charset: [a-z0-9./-]. Mirrors the same charset the
// auto-create lifecycle hook uses, so a worktree branch and an
// auto-create branch derived from the same seed produce comparable
// strings. Empty input → "session" (any non-empty placeholder; "task"
// is what the TS code uses, but the worktree codepath is keyed off
// sessionID, so "session" is the more honest fallback).
func sanitizeBranchSegment(raw string) string {
	lower := strings.ToLower(raw)
	var b strings.Builder
	b.Grow(len(lower))
	for _, r := range lower {
		switch {
		case r >= 'a' && r <= 'z',
			r >= '0' && r <= '9',
			r == '/', r == '-', r == '.':
			b.WriteRune(r)
		default:
			b.WriteByte('-')
		}
	}
	cleaned := strings.TrimLeft(b.String(), "/.-")
	if cleaned == "" {
		return "session"
	}
	return cleaned
}
