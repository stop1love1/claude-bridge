package api

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// TestResolveRepoSubpathRejectsTraversal — the classic `..` escape
// must be caught by the lexical containment check before EvalSymlinks
// ever runs.
func TestResolveRepoSubpathRejectsTraversal(t *testing.T) {
	root := t.TempDir()
	if _, ok := resolveRepoSubpath(root, "../escape"); ok {
		t.Error("expected `../escape` to be rejected")
	}
	if _, ok := resolveRepoSubpath(root, "subdir/../../escape"); ok {
		t.Error("expected nested `..` to be rejected")
	}
}

// TestResolveRepoSubpathRejectsAbsoluteOutside — an absolute `rel`
// pointing outside the repo root must be rejected outright. The old
// implementation accepted any abs path whose lexical prefix matched
// the abs root; that's still rejected here, but absolute paths whose
// prefix doesn't match the root were also previously possible to slip
// through if the caller hand-crafted them.
func TestResolveRepoSubpathRejectsAbsoluteOutside(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir() // sibling temp dir, definitely not under root
	if _, ok := resolveRepoSubpath(root, outside); ok {
		t.Errorf("expected absolute outside path %q to be rejected", outside)
	}
}

// TestResolveRepoSubpathRejectsSymlinkEscape — a symlink planted
// inside the repo whose target sits outside must be rejected even
// though the lexical abs-prefix check would pass.
//
// Symlink creation on Windows requires either developer-mode or
// SeCreateSymbolicLinkPrivilege; skip when the OS denies it so CI on
// stock Windows runners doesn't fail spuriously.
func TestResolveRepoSubpathRejectsSymlinkEscape(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	link := filepath.Join(root, "escape")
	if err := os.Symlink(outside, link); err != nil {
		if runtime.GOOS == "windows" {
			t.Skipf("symlink creation denied on this Windows host: %v", err)
		}
		t.Fatalf("symlink: %v", err)
	}
	// Lexical check would pass — `escape` cleans to `<root>/escape`,
	// which is under <root>. Only EvalSymlinks catches that the real
	// path is the sibling temp dir.
	if _, ok := resolveRepoSubpath(root, "escape"); ok {
		t.Errorf("expected symlinked-out path to be rejected; symlink target=%q", outside)
	}
	// Same check, but on a path the symlink hops through:
	// <root>/escape/foo where the leaf doesn't exist. The walk-up
	// branch must still reject because EvalSymlinks on the parent
	// resolves outside the repo.
	if _, ok := resolveRepoSubpath(root, "escape/foo"); ok {
		t.Error("expected path under symlinked-out dir to be rejected")
	}
}

// TestResolveRepoSubpathAcceptsRealSubdir — non-symlinked descendants
// must still resolve cleanly. Without this, the EvalSymlinks fix
// would over-correct and break the file picker.
func TestResolveRepoSubpathAcceptsRealSubdir(t *testing.T) {
	root := t.TempDir()
	sub := filepath.Join(root, "src", "feature")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	got, ok := resolveRepoSubpath(root, "src/feature")
	if !ok {
		t.Fatal("expected `src/feature` to resolve")
	}
	// Compare via EvalSymlinks because t.TempDir() on macOS resolves
	// through /private/var → /var; the function returns the abs path,
	// which on that platform may or may not be the resolved form.
	wantReal, _ := filepath.EvalSymlinks(sub)
	gotReal, _ := filepath.EvalSymlinks(got)
	if wantReal != gotReal {
		t.Errorf("path: got %q (real %q), want %q (real %q)", got, gotReal, sub, wantReal)
	}
}

// TestResolveRepoSubpathEmptyAndDotMapToRoot — both empty string and
// "." must round-trip to the repo root. The file picker passes "" on
// the initial GET and "." on a refresh; both must work.
func TestResolveRepoSubpathEmptyAndDotMapToRoot(t *testing.T) {
	root := t.TempDir()
	rootReal, _ := filepath.EvalSymlinks(root)
	for _, rel := range []string{"", "."} {
		got, ok := resolveRepoSubpath(root, rel)
		if !ok {
			t.Errorf("rel=%q: expected ok=true", rel)
			continue
		}
		gotReal, _ := filepath.EvalSymlinks(got)
		if gotReal != rootReal {
			t.Errorf("rel=%q: got %q (real %q), want root %q (real %q)", rel, got, gotReal, root, rootReal)
		}
	}
}

// TestResolveRepoSubpathRejectsNUL — the early guard must reject
// before any path math runs.
func TestResolveRepoSubpathRejectsNUL(t *testing.T) {
	root := t.TempDir()
	if _, ok := resolveRepoSubpath(root, "foo\x00bar"); ok {
		t.Error("expected NUL byte to be rejected")
	}
}
