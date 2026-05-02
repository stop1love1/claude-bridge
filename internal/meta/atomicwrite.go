package meta

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"time"
)

// WriteOptions tunes the atomic-write helpers. Mode is the POSIX file
// mode applied to the staged temp BEFORE the rename (rename inherits
// the mode on Linux), then re-applied after the rename on macOS where
// some filesystems retain the destination inode's metadata across the
// rename. Ignored on Windows.
type WriteOptions struct {
	Mode os.FileMode
}

// uniqueTmpPath returns `<filePath>.<pid>.<unixNano>.<rand>.tmp` so two
// concurrent writers can't trample each other's staging file. The
// earlier shared-`.tmp` pattern raced: writer-A writes its bytes,
// writer-B writes its bytes (overwriting A's tmp), then A renames B's
// payload onto the destination — A's intended write is silently lost.
func uniqueTmpPath(filePath string) string {
	var rb [3]byte
	_, _ = rand.Read(rb[:])
	suffix := hex.EncodeToString(rb[:])
	return filePath + "." + strconv.Itoa(os.Getpid()) +
		"." + strconv.FormatInt(time.Now().UnixNano(), 10) +
		"." + suffix + ".tmp"
}

// WriteStringAtomic writes payload to filePath via tempfile + rename.
// Stages to <filePath>.<pid>.<ns>.<rand>.tmp then renames atomically.
// Renames are atomic on POSIX and atomic-on-success on NTFS, so a
// crash mid-write leaves either the old file or the new — never a
// half-written copy.
//
// Mirrors libs/atomicWrite.ts writeStringAtomic exactly: parent dir is
// mkdir'd recursively before staging, rename failure unlinks the
// staged tmp before re-throwing, mode is applied at write + re-applied
// post-rename on non-Windows.
func WriteStringAtomic(filePath, content string, opts *WriteOptions) error {
	dir := filepath.Dir(filePath)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("mkdir %s: %w", dir, err)
	}
	tmp := uniqueTmpPath(filePath)
	mode := os.FileMode(0o644)
	if opts != nil && opts.Mode != 0 {
		mode = opts.Mode
	}
	if err := os.WriteFile(tmp, []byte(content), mode); err != nil {
		return fmt.Errorf("write tmp %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, filePath); err != nil {
		// Unlink the staged tmp before propagating so a filesystem
		// error doesn't leak `.tmp` files indefinitely.
		_ = os.Remove(tmp)
		return fmt.Errorf("rename %s -> %s: %w", tmp, filePath, err)
	}
	if opts != nil && opts.Mode != 0 && runtime.GOOS != "windows" {
		// macOS' HFS / some APFS configurations preserve the
		// destination inode's metadata across rename, silently
		// downgrading the mode we set on the staged tmp. Re-apply.
		_ = os.Chmod(filePath, opts.Mode)
	}
	return nil
}

// WriteJSONAtomic writes a JSON-serializable value to filePath. Output
// uses 2-space indentation and a trailing newline to match the on-disk
// convention the legacy ad-hoc helpers established (and what Next
// readMeta consumers expect bytewise).
//
// Encoding via the package's marshalIndent helper rather than
// json.MarshalIndent directly so callers can override the formatter
// later (e.g. to add a stable key order, or to skip the newline) by
// editing one place.
func WriteJSONAtomic(filePath string, value any, opts *WriteOptions) error {
	body, err := marshalIndent(value)
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}
	return WriteStringAtomic(filePath, string(body)+"\n", opts)
}
