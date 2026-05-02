package memory

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// Pinned-file caps. Per-file is small because the bullet section in
// the prompt has to stay reviewable; total count is bounded so a
// runaway bridge.json with 50 pins doesn't dominate the prompt.
const (
	PinnedPerFileCapBytes = 4 * 1024
	PinnedMaxFiles        = 8
)

// PinnedFile is one resolved entry from an app's pinnedFiles config.
// Rel is always posix-style (forward slashes) so the prompt rendering
// is platform-stable — the loader normalizes Windows separators on
// the way out.
type PinnedFile struct {
	Rel       string
	Content   string
	Truncated bool
}

// LoadPinnedFiles reads the configured pinned files for an app.
// Returns at most PinnedMaxFiles entries, each capped at
// PinnedPerFileCapBytes. Missing files / unsafe paths / read errors
// are silently skipped — pinnedFiles is operator config and a soft
// failure (rename, refactor, missing checkout) shouldn't block the
// spawn. Callers gate the prompt section on len(result) > 0.
func LoadPinnedFiles(appPath string, pinnedFiles []string) []PinnedFile {
	if appPath == "" || len(pinnedFiles) == 0 {
		return nil
	}
	out := make([]PinnedFile, 0, len(pinnedFiles))
	for _, raw := range pinnedFiles {
		if len(out) >= PinnedMaxFiles {
			break
		}
		rel := strings.TrimSpace(raw)
		if rel == "" {
			continue
		}
		abs, ok := resolveSafely(appPath, rel)
		if !ok {
			continue
		}
		content, truncated, ok := readCapped(abs)
		if !ok {
			continue
		}
		out = append(out, PinnedFile{
			Rel:       filepath.ToSlash(rel),
			Content:   content,
			Truncated: truncated,
		})
	}
	return out
}

// resolveSafely rejects absolute pins and pins that escape the app
// root via `..`. Defense against a tampered bridge.json pointing at
// `/etc/passwd` or `../../secrets`. We resolve through filepath.Clean
// (via Abs / Join) so symlink-style traversals still get caught by
// the prefix check.
//
// Returns (abs, true) on success, ("", false) on rejection.
func resolveSafely(appPath, rel string) (string, bool) {
	if rel == "" || filepath.IsAbs(rel) {
		return "", false
	}
	abs := filepath.Join(appPath, rel)
	// filepath.Rel canonicalizes both sides; if the relative form
	// starts with `..` or is itself absolute (Windows drive switch),
	// the pin escapes the app root.
	within, err := filepath.Rel(appPath, abs)
	if err != nil {
		return "", false
	}
	if within == ".." || strings.HasPrefix(within, ".."+string(filepath.Separator)) {
		return "", false
	}
	if filepath.IsAbs(within) {
		return "", false
	}
	return abs, true
}

// readCapped reads up to PinnedPerFileCapBytes+1 bytes so we can
// detect truncation without slurping the full file. Returns content
// (capped to the limit), a truncation flag, and ok=false on read
// error. The +1 means a file exactly at the cap reports truncated=false.
func readCapped(absPath string) (string, bool, bool) {
	f, err := os.Open(absPath)
	if err != nil {
		return "", false, false
	}
	defer f.Close()
	buf := make([]byte, PinnedPerFileCapBytes+1)
	n, err := io.ReadFull(f, buf)
	// ReadFull treats short reads (file smaller than buf) as
	// ErrUnexpectedEOF; for capped reads that's the normal case, so
	// only propagate other errors.
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		return "", false, false
	}
	truncated := n > PinnedPerFileCapBytes
	if truncated {
		n = PinnedPerFileCapBytes
	}
	return string(buf[:n]), truncated, true
}
