package memory

import (
	"context"
	"os/exec"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/stop1love1/claude-bridge/internal/symbol"
)

// Recent-direction caps. The 3s git timeout matches libs/recentDirection.ts —
// the spawn flow's existing git pre-warm already keeps git responsive,
// so 3s is generous. The 30-line cap on the rendered log keeps the
// prompt section legible (one screen of `git log --stat`).
const (
	recentGitTimeout = 3 * time.Second
	recentLogLineCap = 30
)

// RecentDirection is the result of LoadRecentDirection. Dir is
// app-relative with posix separators so the rendered prompt is
// platform-stable. An empty Dir signals "no useful section to render"
// — the caller skips the section entirely rather than emitting an
// empty heading.
type RecentDirection struct {
	Dir       string
	Log       string
	Truncated bool
}

// RecentOptions bundles the auto-pick inputs. When Dir on the
// LoadRecentDirection call is non-empty the caller has already chosen
// a focus area (e.g. via `taskApp` config) and TaskBody / SymbolIndex
// are unused; otherwise PickTouchedDir runs against them.
type RecentOptions struct {
	TaskBody    string
	SymbolIndex symbol.SymbolIndex
}

// PickTouchedDir picks a single "touched dir" from the task body using
// the same scored-symbol heuristic as AttachReferences. Returns "" when
// no candidate scored above threshold or when the top candidate's
// parent is the repo root (".") — surfacing "git log --stat -- ." would
// be no-better than the agent reading the full history and we'd waste
// the 30-line budget on noise.
func PickTouchedDir(taskBody string, index symbol.SymbolIndex) string {
	if len(index.Symbols) == 0 {
		return ""
	}
	tokens := Tokenize(taskBody)
	if len(tokens) == 0 {
		return ""
	}
	candidates := PickCandidateFiles(index.Symbols, tokens)
	if len(candidates) == 0 {
		return ""
	}
	top := candidates[0]
	// Use path.Dir (not filepath.Dir) because the candidate file paths
	// live in the symbol index already normalized to posix separators
	// — using filepath.Dir on Windows would re-introduce backslashes.
	dir := path.Dir(filepath.ToSlash(top.File))
	if dir == "" || dir == "." {
		return ""
	}
	return dir
}

// LoadRecentDirection runs `git -C <repoCwd> log --stat -10 -- <dir>`
// and returns the capped result. When dir is "" PickTouchedDir runs
// first against opts.TaskBody + opts.SymbolIndex; if that also returns
// "" the function returns a zero-value RecentDirection (Dir == "").
//
// Returns a zero-value (no error) in every "soft failure" case —
// missing git binary, non-git working tree, timeout, empty log.
// The prompt builder uses Dir == "" as the skip signal; promoting any
// of these to an error would force every caller to wrap LoadRecentDirection
// in an `if err != nil { /* ignore, continue without section */ }`
// block. The error return is reserved for "the caller handed us
// something structurally broken" which currently means "nothing" —
// kept on the signature for future-proofing the API.
func LoadRecentDirection(repoCwd, dir string, opts RecentOptions) (RecentDirection, error) {
	if dir == "" {
		dir = PickTouchedDir(opts.TaskBody, opts.SymbolIndex)
	}
	if dir == "" {
		return RecentDirection{}, nil
	}
	if repoCwd == "" {
		return RecentDirection{}, nil
	}
	// LookPath miss = git not on PATH; we silently degrade so the
	// rest of the prompt still builds. The TS port had the same shape
	// (catch + null) — surfacing this as an error would noise up
	// every spawn that runs against a non-git scratch dir.
	if _, err := exec.LookPath("git"); err != nil {
		return RecentDirection{}, nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), recentGitTimeout)
	defer cancel()

	// `-C <cwd>` rather than cmd.Dir so the same invocation works
	// when the caller passes a path that doesn't yet exist (git will
	// fail-fast with a clear message captured into stderr — we
	// discard stderr because the caller doesn't need it). `--` then
	// dir disambiguates pathspec vs. ref name (a dir literally named
	// "main" would otherwise shadow the branch).
	cmd := exec.CommandContext(ctx, "git", "-C", repoCwd, "log", "--stat", "-10", "--", dir)
	out, err := cmd.Output()
	if err != nil {
		// Non-git tree, timeout, missing dir — same soft fail.
		return RecentDirection{}, nil
	}
	trimmed := strings.TrimRight(string(out), "\r\n\t ")
	if trimmed == "" {
		return RecentDirection{}, nil
	}

	// Split on either CRLF or LF so a Windows-checkout `core.autocrlf`
	// run doesn't truncate every other line. SplitN with -1 keeps all
	// trailing pieces — important so an exactly-cap-sized log doesn't
	// lose its last entry to a slice off-by-one.
	lines := splitLines(trimmed)
	truncated := len(lines) > recentLogLineCap
	log := trimmed
	if truncated {
		log = strings.Join(lines[:recentLogLineCap], "\n")
	}
	return RecentDirection{
		Dir:       dir,
		Log:       log,
		Truncated: truncated,
	}, nil
}

// splitLines splits on `\n` and strips a trailing `\r` per piece —
// the equivalent of TS's `/\r?\n/` regex split, but allocation-free
// on the common LF-only path.
func splitLines(s string) []string {
	parts := strings.Split(s, "\n")
	for i, p := range parts {
		parts[i] = strings.TrimRight(p, "\r")
	}
	return parts
}
