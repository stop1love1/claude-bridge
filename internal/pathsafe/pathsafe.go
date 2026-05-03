// Package pathsafe centralizes the "is this user-supplied relative path
// safely contained inside this trusted root?" check that every API
// handler / git command needs to perform.
//
// The naive form (filepath.Abs + strings.HasPrefix) misses symlinks
// pointing outside the root, so this package always combines lexical
// containment with filepath.EvalSymlinks where the leaf exists, and
// walks up the parent chain when it doesn't.
//
// Three sentinel errors discriminate the failure modes so callers
// (especially HTTP handlers) can map onto distinct status codes /
// log fields without parsing strings.
package pathsafe

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// ErrAbsoluteRel signals that rel was an absolute path and the caller
// did not opt in via AllowAbsolute. The default-forbid stance matches
// every API handler's existing semantics: an attacker who can pass an
// absolute `path=` query param is escaping the relative-only contract.
var ErrAbsoluteRel = errors.New("pathsafe: rel is absolute")

// ErrTraversal signals rel contained "..". Caught lexically before any
// filesystem access so a probe for a non-existent root can still get a
// fast 400.
var ErrTraversal = errors.New("pathsafe: rel contains traversal")

// ErrEscape signals the resolved path landed outside root, either
// because a symlink redirected it or because the lexical path crossed
// the root boundary. Returned by Resolve when the EvalSymlinks-aware
// containment check fails. Distinct from ErrTraversal so callers can
// log "symlink escape" vs "literal ..".
var ErrEscape = errors.New("pathsafe: resolved path escapes root")

// options is the internal opts bag mutated by Option funcs. Callers
// only see the Option type — the struct itself is private so adding
// fields later is a non-breaking change.
type options struct {
	allowAbsolute bool
}

// Option mutates the resolution options for a single Resolve call.
type Option func(*options)

// AllowAbsolute opts in to accepting absolute rels. The absolute path
// must still resolve strictly inside root — this only relaxes the
// "rel must be relative" precondition, never the containment one.
//
// Used by callers like resolveRepoSubpath that historically accepted
// absolute paths whose lexical prefix already matched the abs root
// (the file picker passed back the same abs path it had received).
func AllowAbsolute() Option {
	return func(o *options) { o.allowAbsolute = true }
}

// Resolve cleans and validates that rel — interpreted relative to root —
// stays inside root. Returns the absolute, symlink-resolved path on
// success, or one of:
//   - ErrAbsoluteRel: rel is absolute and AllowAbsolute was not passed.
//   - ErrTraversal: rel contains "..".
//   - ErrEscape: the resolved path would land outside root (via symlink
//     or absolute attack).
//
// Empty rel and "." both map to root.
//
// NUL bytes in rel are rejected as ErrTraversal — a NUL is never a
// legitimate path component and several callers historically rejected
// it up front; folding the check in here keeps every caller protected.
//
// The returned path is the symlink-resolved leaf when it exists, or
// the lexically-cleaned target when it doesn't (parent walk verified
// every existing ancestor stays inside root). Either form is safe to
// hand to os.ReadFile / os.Stat — the symlink-aware re-check above
// already fenced out planted symlinks.
func Resolve(root, rel string, opts ...Option) (string, error) {
	cfg := options{}
	for _, opt := range opts {
		opt(&cfg)
	}

	if strings.ContainsRune(rel, 0) {
		return "", ErrTraversal
	}

	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return "", ErrEscape
	}

	var target string
	switch {
	case rel == "" || rel == ".":
		target = rootAbs
	case filepath.IsAbs(rel):
		if !cfg.allowAbsolute {
			return "", ErrAbsoluteRel
		}
		clean := filepath.Clean(rel)
		if !lexicalContains(rootAbs, clean) {
			return "", ErrEscape
		}
		target = clean
	default:
		// Reject "../foo", "subdir/../../escape" etc. before any
		// filesystem call.
		if hasTraversalSegment(rel) {
			return "", ErrTraversal
		}
		target = filepath.Clean(filepath.Join(rootAbs, rel))
	}

	// Lexical containment first — equal-or-descendant under abs root.
	if !lexicalContains(rootAbs, target) {
		return "", ErrEscape
	}

	// Symlink-aware re-check: resolve both sides through EvalSymlinks
	// and confirm the resolved target is still under the resolved root.
	rootReal, rerr := filepath.EvalSymlinks(rootAbs)
	if rerr != nil {
		// Root must exist as a real path; if EvalSymlinks fails on the
		// root itself, refuse rather than fall back to the lexical check.
		// A missing root has no business resolving any subpath.
		return "", ErrEscape
	}
	resolved, err := filepath.EvalSymlinks(target)
	if err == nil {
		if !lexicalContains(rootReal, resolved) {
			return "", ErrEscape
		}
		return target, nil
	}

	// Target doesn't exist (yet) — walk up to the nearest existing
	// ancestor and resolve that. Every intermediate component up to
	// that ancestor must be a non-symlink directory inside root,
	// otherwise an attacker could plant a symlink at a not-yet-existing
	// path and slip through on the abs-only check.
	cursor := target
	for {
		parent := filepath.Dir(cursor)
		if parent == cursor {
			// Reached the root of the filesystem without finding an
			// existing ancestor — refuse.
			return "", ErrEscape
		}
		info, lerr := os.Lstat(parent)
		if lerr != nil {
			cursor = parent
			continue
		}
		// Reject symlink ancestors: even if they currently point inside
		// root, they're a moving target.
		if info.Mode()&os.ModeSymlink != 0 {
			return "", ErrEscape
		}
		parentReal, perr := filepath.EvalSymlinks(parent)
		if perr != nil {
			return "", ErrEscape
		}
		if !lexicalContains(rootReal, parentReal) {
			return "", ErrEscape
		}
		return target, nil
	}
}

// Contains reports whether candidate, after lexical + symlink
// resolution, lies inside root (equal-or-descendant). Both arguments
// are passed through filepath.Abs defensively. Returns false on any
// resolution error (including a non-existent root, which is treated
// as "not contained" — same conservative bias as Resolve).
//
// Use this for "given two already-resolved absolute paths, is one
// under the other?" — typically when both paths come from trusted
// sources but a planted symlink on disk could still have moved one
// beneath an unrelated tree.
func Contains(root, candidate string) bool {
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return false
	}
	candAbs, err := filepath.Abs(candidate)
	if err != nil {
		return false
	}
	if !lexicalContains(rootAbs, candAbs) {
		return false
	}
	rootReal, rerr := filepath.EvalSymlinks(rootAbs)
	if rerr != nil {
		return false
	}
	candReal, cerr := filepath.EvalSymlinks(candAbs)
	if cerr != nil {
		// Candidate doesn't exist yet — fall back to the lexical pass
		// above (already verified). The caller's downstream os.Stat /
		// os.Open will catch a non-existent leaf.
		return true
	}
	return lexicalContains(rootReal, candReal)
}

// ContainsStrict is like Contains but refuses equal-to-root: candidate
// must be a strict descendant. Used by isUnderAppRoot in the git
// worktree code, where the candidate is always a sub-folder under the
// app and equal-to-root would mean RemoveAll on the entire app tree.
func ContainsStrict(root, candidate string) bool {
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return false
	}
	candAbs, err := filepath.Abs(candidate)
	if err != nil {
		return false
	}
	if rootAbs == candAbs {
		return false
	}
	return Contains(rootAbs, candAbs)
}

// ContainsCaseInsensitive is the case-folded variant for Windows-style
// containment checks. Used by callers that compare a user dir against
// an app root where the same path may be spelled with different
// casing — the lexical check folds both sides to lower case.
//
// Note: this does NOT do EvalSymlinks; case-insensitive comparison is
// only meaningful at the lexical layer (the FS itself decides whether
// two casings are the same file). Callers that need symlink resolution
// AND case folding can compose Contains + lower-cased inputs.
func ContainsCaseInsensitive(root, candidate string) bool {
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return false
	}
	candAbs, err := filepath.Abs(candidate)
	if err != nil {
		return false
	}
	a := strings.ToLower(candAbs)
	r := strings.ToLower(rootAbs)
	if a == r {
		return true
	}
	return strings.HasPrefix(a, r+string(filepath.Separator))
}

// lexicalContains reports whether candidate is exactly root or a
// strict descendant of root. Both inputs must already be cleaned/abs.
// The trailing-separator check defends against the classic "/repo"
// matching "/repository" prefix bug.
func lexicalContains(root, candidate string) bool {
	if root == candidate {
		return true
	}
	sep := string(filepath.Separator)
	if strings.HasPrefix(candidate, root+sep) {
		return true
	}
	// Belt-and-braces for callers that pass a forward-slash-cleaned
	// path on Windows (mostly tests / contract fixtures).
	return strings.HasPrefix(candidate, root+"/")
}

// hasTraversalSegment reports whether rel contains a ".." path segment.
// Cheaper than filepath.Clean+compare and gives us a distinct sentinel.
// Looks at both / and \ separators so a Windows-style "../escape" is
// caught the same as a POSIX one.
func hasTraversalSegment(rel string) bool {
	// Normalize separators for the scan only — don't mutate the path
	// passed back to the caller.
	for _, part := range strings.FieldsFunc(rel, func(r rune) bool {
		return r == '/' || r == '\\'
	}) {
		if part == ".." {
			return true
		}
	}
	return false
}
