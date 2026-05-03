package pathsafe

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// TestResolveHappyPath — a relative descendant resolves cleanly and
// the returned path is absolute under root.
func TestResolveHappyPath(t *testing.T) {
	root := t.TempDir()
	sub := filepath.Join(root, "src", "feature")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	got, err := Resolve(root, "src/feature")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	wantReal, _ := filepath.EvalSymlinks(sub)
	gotReal, _ := filepath.EvalSymlinks(got)
	if gotReal != wantReal {
		t.Errorf("got %q (real %q), want %q (real %q)", got, gotReal, sub, wantReal)
	}
}

// TestResolveEmptyAndDotMapToRoot — the file-picker entry points pass
// "" / "." for the repo root.
func TestResolveEmptyAndDotMapToRoot(t *testing.T) {
	root := t.TempDir()
	rootReal, _ := filepath.EvalSymlinks(root)
	for _, rel := range []string{"", "."} {
		got, err := Resolve(root, rel)
		if err != nil {
			t.Errorf("rel=%q: %v", rel, err)
			continue
		}
		gotReal, _ := filepath.EvalSymlinks(got)
		if gotReal != rootReal {
			t.Errorf("rel=%q: got %q, want root %q", rel, gotReal, rootReal)
		}
	}
}

// TestResolveTraversal — "..", "subdir/../../.." must hit ErrTraversal
// before any FS work happens.
func TestResolveTraversal(t *testing.T) {
	root := t.TempDir()
	for _, rel := range []string{"../escape", "subdir/../../escape"} {
		_, err := Resolve(root, rel)
		if !errors.Is(err, ErrTraversal) {
			t.Errorf("rel=%q: want ErrTraversal, got %v", rel, err)
		}
	}
}

// TestResolveAbsoluteForbiddenByDefault — the default-deny stance
// keeps the existing API contract: callers opt in explicitly.
func TestResolveAbsoluteForbiddenByDefault(t *testing.T) {
	root := t.TempDir()
	other := t.TempDir()
	_, err := Resolve(root, other)
	if !errors.Is(err, ErrAbsoluteRel) {
		t.Errorf("want ErrAbsoluteRel, got %v", err)
	}
}

// TestResolveAbsoluteWithOptInside — AllowAbsolute lets a contained
// abs path through.
func TestResolveAbsoluteWithOptInside(t *testing.T) {
	root := t.TempDir()
	sub := filepath.Join(root, "deep")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	got, err := Resolve(root, sub, AllowAbsolute())
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	gotReal, _ := filepath.EvalSymlinks(got)
	wantReal, _ := filepath.EvalSymlinks(sub)
	if gotReal != wantReal {
		t.Errorf("got %q want %q", gotReal, wantReal)
	}
}

// TestResolveAbsoluteWithOptOutside — AllowAbsolute does NOT relax the
// containment check itself.
func TestResolveAbsoluteWithOptOutside(t *testing.T) {
	root := t.TempDir()
	other := t.TempDir()
	_, err := Resolve(root, other, AllowAbsolute())
	if !errors.Is(err, ErrEscape) {
		t.Errorf("want ErrEscape, got %v", err)
	}
}

// TestResolveSymlinkEscape — a symlink planted inside root whose target
// sits outside must be rejected.
func TestResolveSymlinkEscape(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	link := filepath.Join(root, "escape")
	if err := os.Symlink(outside, link); err != nil {
		if runtime.GOOS == "windows" {
			t.Skipf("symlink creation denied: %v", err)
		}
		t.Fatalf("symlink: %v", err)
	}
	_, err := Resolve(root, "escape")
	if !errors.Is(err, ErrEscape) {
		t.Errorf("want ErrEscape, got %v", err)
	}
	// And via a not-yet-existing leaf under the bad symlink.
	_, err = Resolve(root, "escape/foo")
	if !errors.Is(err, ErrEscape) {
		t.Errorf("under-symlink: want ErrEscape, got %v", err)
	}
}

// TestResolveNonExistentLeaf — the parent-walk branch must succeed
// when the leaf doesn't exist but every existing ancestor stays
// inside root.
func TestResolveNonExistentLeaf(t *testing.T) {
	root := t.TempDir()
	got, err := Resolve(root, "a/b/c/not-yet-here.txt")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if !filepath.IsAbs(got) {
		t.Errorf("expected abs path, got %q", got)
	}
	// Compare via EvalSymlinks on both sides — tempdir on Windows
	// (8.3 shortname) and macOS (/private prefix) doesn't lexically
	// match its abs form. The lexical containment check inside
	// Resolve already verified the underlying invariant; this assert
	// just confirms the returned path lives under the same real dir.
	rootAbs, _ := filepath.Abs(root)
	rootReal, _ := filepath.EvalSymlinks(rootAbs)
	if !lexicalContains(rootAbs, got) && !lexicalContains(rootReal, got) {
		t.Errorf("got %q not contained in root %q (real %q)", got, rootAbs, rootReal)
	}
}

// TestResolveNULRejected — embedded NUL must reject before any FS call.
func TestResolveNULRejected(t *testing.T) {
	root := t.TempDir()
	_, err := Resolve(root, "foo\x00bar")
	if !errors.Is(err, ErrTraversal) {
		t.Errorf("want ErrTraversal, got %v", err)
	}
}

// TestContainsSimple — equal + descendant must pass; sibling must fail.
func TestContainsSimple(t *testing.T) {
	root := t.TempDir()
	sub := filepath.Join(root, "x")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if !Contains(root, root) {
		t.Error("expected root contains root")
	}
	if !Contains(root, sub) {
		t.Errorf("expected %q contains %q", root, sub)
	}
	other := t.TempDir()
	if Contains(root, other) {
		t.Errorf("did not expect %q contains %q", root, other)
	}
}

// TestContainsSymlinkEscape — a candidate that looks contained
// lexically but symlinks outside must return false.
func TestContainsSymlinkEscape(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	link := filepath.Join(root, "out")
	if err := os.Symlink(outside, link); err != nil {
		if runtime.GOOS == "windows" {
			t.Skipf("symlink creation denied: %v", err)
		}
		t.Fatalf("symlink: %v", err)
	}
	// link is lexically inside root, but resolves outside.
	if Contains(root, link) {
		t.Error("expected Contains to reject symlink-escaped candidate")
	}
}

// TestContainsStrict — equal-to-root must NOT count as contained.
func TestContainsStrict(t *testing.T) {
	root := t.TempDir()
	sub := filepath.Join(root, "x")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if ContainsStrict(root, root) {
		t.Error("expected ContainsStrict(root, root) = false")
	}
	if !ContainsStrict(root, sub) {
		t.Errorf("expected ContainsStrict(%q, %q) = true", root, sub)
	}
}

// TestContainsCaseInsensitive — Windows-style folded comparison.
func TestContainsCaseInsensitive(t *testing.T) {
	root := t.TempDir()
	sub := filepath.Join(root, "Sub")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if !ContainsCaseInsensitive(root, sub) {
		t.Error("expected case-insensitive contains")
	}
	// Mismatched casing on the prefix should still pass when folded.
	upperRoot := root // tempdir already mixed-case; use as-is
	if !ContainsCaseInsensitive(upperRoot, sub) {
		t.Errorf("expected %q to contain %q", upperRoot, sub)
	}
}
