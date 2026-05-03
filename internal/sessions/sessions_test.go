package sessions

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPathToSlug(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"converts Windows drive path to Claude slug", `C:\projects\my-bridge`, "C--projects-my-bridge"},
		{"collapses dots in folder names (matches Claude's slug)", `C:\projects\my.app.vn\my-bridge`, "C--projects-my-app-vn-my-bridge"},
		{"converts POSIX path to Claude slug", "/home/u/some-app", "-home-u-some-app"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := PathToSlug(tc.in); got != tc.want {
				t.Errorf("PathToSlug(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// writeFile is a fatal-on-error helper for test setup.
func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

func sessionIDs(entries []Entry) []string {
	ids := make([]string, len(entries))
	for i, e := range entries {
		ids[i] = e.SessionID
	}
	return ids
}

func TestListSessions(t *testing.T) {
	t.Run("hides leaf-pointer stub files that contain only `last-prompt`", func(t *testing.T) {
		ResetScanHeadCacheForTests()
		dir := t.TempDir()
		writeFile(t, filepath.Join(dir, "stub.jsonl"),
			`{"type":"last-prompt","lastPrompt":"hi","leafUuid":"x","sessionId":"stub"}`+"\n")
		writeFile(t, filepath.Join(dir, "real.jsonl"),
			`{"type":"user","message":{"role":"user","content":"hello"}}`+"\n")

		got := ListSessions(dir)
		ids := sessionIDs(got)
		if len(ids) != 1 || ids[0] != "real" {
			t.Fatalf("session IDs = %v, want [real]", ids)
		}
		if got[0].Preview != "hello" {
			t.Errorf("preview = %q, want %q", got[0].Preview, "hello")
		}
	})

	t.Run("keeps assistant-only sessions (no user line yet) but with empty preview", func(t *testing.T) {
		ResetScanHeadCacheForTests()
		dir := t.TempDir()
		writeFile(t, filepath.Join(dir, "asst.jsonl"),
			`{"type":"assistant","message":{"role":"assistant","content":"…"}}`+"\n")

		got := ListSessions(dir)
		ids := sessionIDs(got)
		if len(ids) != 1 || ids[0] != "asst" {
			t.Fatalf("session IDs = %v, want [asst]", ids)
		}
		if got[0].Preview != "" {
			t.Errorf("preview = %q, want empty", got[0].Preview)
		}
	})

	t.Run("keeps real sessions whose first user line is past the 8 KB head", func(t *testing.T) {
		ResetScanHeadCacheForTests()
		dir := t.TempDir()
		bigBlob := strings.Repeat("x", 64*1024)
		content := strings.Join([]string{
			`{"type":"queue-operation","op":"enqueue"}`,
			`{"type":"attachment","data":"` + bigBlob + `"}`,
			`{"type":"user","message":{"role":"user","content":"hello past 8KB"}}`,
		}, "\n") + "\n"
		writeFile(t, filepath.Join(dir, "huge-head.jsonl"), content)

		got := ListSessions(dir)
		ids := sessionIDs(got)
		if len(ids) != 1 || ids[0] != "huge-head" {
			t.Fatalf("session IDs = %v, want [huge-head]", ids)
		}
		if got[0].Preview != "hello past 8KB" {
			t.Errorf("preview = %q, want %q", got[0].Preview, "hello past 8KB")
		}
	})
}

func TestScanSessionHeadCache(t *testing.T) {
	t.Run("reuses the cached preview when (mtime, size) is unchanged", func(t *testing.T) {
		ResetScanHeadCacheForTests()
		dir := t.TempDir()
		file := filepath.Join(dir, "real.jsonl")
		// Equal byte length so the cache key's size component doesn't shift.
		content1 := `{"type":"user","message":{"role":"user","content":"alpha-text"}}` + "\n"
		content2 := `{"type":"user","message":{"role":"user","content":"omega-text"}}` + "\n"
		if len(content1) != len(content2) {
			t.Fatalf("test bug: content1 (%d) != content2 (%d) bytes", len(content1), len(content2))
		}
		writeFile(t, file, content1)
		first := ListSessions(dir)
		if len(first) != 1 || first[0].Preview != "alpha-text" {
			t.Fatalf("first list preview = %q, want alpha-text", first[0].Preview)
		}

		st, err := os.Stat(file)
		if err != nil {
			t.Fatalf("stat: %v", err)
		}
		writeFile(t, file, content2)
		// Restore atime + mtime so the cache key collides.
		if err := os.Chtimes(file, st.ModTime(), st.ModTime()); err != nil {
			t.Fatalf("chtimes: %v", err)
		}

		second := ListSessions(dir)
		if len(second) != 1 || second[0].Preview != "alpha-text" {
			t.Errorf("second list preview = %q, want alpha-text (cached)", second[0].Preview)
		}
	})

	t.Run("misses when mtime changes", func(t *testing.T) {
		ResetScanHeadCacheForTests()
		dir := t.TempDir()
		file := filepath.Join(dir, "real.jsonl")
		writeFile(t, file, `{"type":"user","message":{"role":"user","content":"alpha"}}`+"\n")
		first := ListSessions(dir)
		if len(first) != 1 || first[0].Preview != "alpha" {
			t.Fatalf("first list preview = %q, want alpha", first[0].Preview)
		}

		st, err := os.Stat(file)
		if err != nil {
			t.Fatalf("stat: %v", err)
		}
		writeFile(t, file, `{"type":"user","message":{"role":"user","content":"beta"}}`+"\n")
		future := st.ModTime().Add(5 * time.Second)
		if err := os.Chtimes(file, future, future); err != nil {
			t.Fatalf("chtimes: %v", err)
		}

		second := ListSessions(dir)
		if len(second) != 1 || second[0].Preview != "beta" {
			t.Errorf("second list preview = %q, want beta (fresh)", second[0].Preview)
		}
	})

	t.Run("does not cache results for missing files", func(t *testing.T) {
		ResetScanHeadCacheForTests()
		dir := t.TempDir()
		if got := ListSessions(dir); len(got) != 0 {
			t.Fatalf("empty dir list = %v, want empty", got)
		}

		file := filepath.Join(dir, "real.jsonl")
		writeFile(t, file, `{"type":"user","message":{"role":"user","content":"now real"}}`+"\n")
		out := ListSessions(dir)
		ids := sessionIDs(out)
		if len(ids) != 1 || ids[0] != "real" {
			t.Fatalf("session IDs = %v, want [real]", ids)
		}
		if out[0].Preview != "now real" {
			t.Errorf("preview = %q, want %q", out[0].Preview, "now real")
		}
	})
}

// TestReadSessionCwdHandlesLongLine covers the bufio.Scanner-ceiling
// regression: prior versions used a Scanner with a 1 MB max-line buffer
// over a 16 KB head slice, which tore in two ways — (a) any session
// whose first line exceeded the scanner cap aborted with
// bufio.ErrTooLong; (b) the 16 KB head was too small for modern
// transcripts whose first line embeds a multi-KB attachment. Both
// silently broke orphan-project recovery: ReadSessionCwd returned
// ("", false) and the discovered project showed up under its slug
// instead of a real path.
//
// The fix is twofold: bufio.Reader (no per-line cap) and a 256 KB head
// window. This test exercises a 200 KB line 1 that still carries the
// cwd field — neither change alone is enough; both must hold.
func TestReadSessionCwdHandlesLongFirstLine(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "huge-line1.jsonl")

	// Build a single ~200 KB JSON line with a real cwd field. We pad the
	// `pad` field with 'x' so the line is well past any 16 KB cap but
	// below the 256 KB head window.
	pad := strings.Repeat("x", 200*1024)
	line1 := `{"cwd":"/home/u/recovered-proj","pad":"` + pad + `"}`
	body := line1 + "\n"
	writeFile(t, file, body)

	cwd, ok := ReadSessionCwd(file)
	if !ok {
		t.Fatalf("ReadSessionCwd ok = false for 200 KB line-1, want true")
	}
	if cwd != "/home/u/recovered-proj" {
		t.Errorf("cwd = %q, want /home/u/recovered-proj", cwd)
	}
}

// TestReadSessionCwdSkipsBigLinesAndFindsCwdLater verifies that when
// the head holds several large but cwd-less lines, the scan keeps going
// and recovers the cwd from a later line (here, line 5). With the old
// Scanner, the first oversize line would have aborted the scan with
// ErrTooLong and the cwd would never have been found.
func TestReadSessionCwdSkipsBigLinesAndFindsCwdLater(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "cwd-on-line5.jsonl")

	// Four ~30 KB lines without a cwd, then a normal line that has it.
	// Total well under 256 KB so it stays in the head window.
	bigBlob := strings.Repeat("y", 30*1024)
	bigLine := `{"type":"queue-operation","payload":"` + bigBlob + `"}`
	cwdLine := `{"type":"user","cwd":"/home/u/late-cwd","message":{"role":"user","content":"hi"}}`
	body := strings.Join([]string{
		bigLine,
		bigLine,
		bigLine,
		bigLine,
		cwdLine,
	}, "\n") + "\n"
	writeFile(t, file, body)

	cwd, ok := ReadSessionCwd(file)
	if !ok {
		t.Fatalf("ReadSessionCwd ok = false when cwd is on line 5 after big lines, want true")
	}
	if cwd != "/home/u/late-cwd" {
		t.Errorf("cwd = %q, want /home/u/late-cwd", cwd)
	}
}

func TestResolveSessionFile(t *testing.T) {
	const validSID = "0123abcd-4567-89ef-cdef-0123456789ab"

	mkProjectDir := func(t *testing.T, root, repo string) string {
		t.Helper()
		dir := filepath.Join(root, PathToSlug(repo))
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", dir, err)
		}
		return dir
	}

	t.Run("resolves to <root>/<slug>/<sid>.jsonl when the project dir exists", func(t *testing.T) {
		root := t.TempDir()
		r := &Reader{Root: root}
		repo := "/home/u/proj-a"
		dir := mkProjectDir(t, root, repo)

		got, ok := r.ResolveSessionFile(repo, validSID)
		if !ok {
			t.Fatalf("ResolveSessionFile ok = false, want true")
		}
		want := filepath.Join(dir, validSID+".jsonl")
		// Compare via filepath.Clean / Abs to normalize any case/symlink
		// drift on the Windows tmp path.
		gotAbs, _ := filepath.Abs(got)
		wantAbs, _ := filepath.Abs(want)
		if gotAbs != wantAbs {
			t.Errorf("path = %q, want %q", gotAbs, wantAbs)
		}
	})

	t.Run("returns null when the project dir does not exist", func(t *testing.T) {
		root := t.TempDir()
		r := &Reader{Root: root}
		if _, ok := r.ResolveSessionFile("/home/u/never-claude-here", validSID); ok {
			t.Errorf("ok = true for missing project dir, want false")
		}
	})

	t.Run("returns null for an invalid sessionId", func(t *testing.T) {
		root := t.TempDir()
		r := &Reader{Root: root}
		repo := "/home/u/proj-b"
		mkProjectDir(t, root, repo)
		for _, sid := range []string{"not-a-uuid", "", "../etc"} {
			if _, ok := r.ResolveSessionFile(repo, sid); ok {
				t.Errorf("ok = true for sessionID %q, want false", sid)
			}
		}
	})

	t.Run("rejects empty repo, oversize repo, and NUL-byte repo", func(t *testing.T) {
		root := t.TempDir()
		r := &Reader{Root: root}
		repos := []string{"", strings.Repeat("a", 5000), "/home/u/proj\x00evil"}
		for _, repo := range repos {
			if _, ok := r.ResolveSessionFile(repo, validSID); ok {
				t.Errorf("ok = true for repo %q, want false", repo)
			}
		}
	})

	t.Run("rejects probe-by-guess: a repoPath whose slug points outside the projects root", func(t *testing.T) {
		root := t.TempDir()
		r := &Reader{Root: root}
		for _, repo := range []string{"/etc", "../../etc/passwd", "/var/log/secret"} {
			if _, ok := r.ResolveSessionFile(repo, validSID); ok {
				t.Errorf("ok = true for unmapped repo %q, want false", repo)
			}
		}
	})

	t.Run("does NOT require the .jsonl file itself to exist (caller decides)", func(t *testing.T) {
		root := t.TempDir()
		r := &Reader{Root: root}
		repo := "/home/u/proj-c"
		dir := mkProjectDir(t, root, repo)

		got, ok := r.ResolveSessionFile(repo, validSID)
		if !ok {
			t.Fatalf("ok = false, want true (project dir exists, .jsonl absence is fine)")
		}
		want := filepath.Join(dir, validSID+".jsonl")
		gotAbs, _ := filepath.Abs(got)
		wantAbs, _ := filepath.Abs(want)
		if gotAbs != wantAbs {
			t.Errorf("path = %q, want %q", gotAbs, wantAbs)
		}
		if _, err := os.Stat(got); err == nil {
			t.Errorf("the .jsonl file unexpectedly exists at %q", got)
		}
	})
}
