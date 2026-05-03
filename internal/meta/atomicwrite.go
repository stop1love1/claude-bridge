package meta

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"time"
)

// marshalIndent matches the byte shape libs/atomicWrite.ts produces:
// JSON.stringify(value, null, 2) — 2-space indent, no trailing newline
// (the trailing newline is added by WriteStringAtomic instead, mirroring
// writeJsonAtomic's `+ "\n"`).
//
// Centralized so a future bytewise-parity adjustment (Next.js's
// JSON.stringify orders object keys differently from json.Marshal in
// some edge cases) lands in one file.
func marshalIndent(value any) ([]byte, error) {
	return json.MarshalIndent(value, "", "  ")
}

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
// Durability path (POSIX): write bytes -> f.Sync() -> f.Close() ->
// rename -> fsync(parent dir). Without the file fsync before rename,
// a power cut can leave the rename committed but the inode's data
// unflushed -> the destination has zero bytes after recovery. Without
// the parent-dir fsync, the rename itself can be lost on recovery on
// some filesystems. Both are no-ops on Windows (ReFS/NTFS handles
// metadata journaling internally; Go can't open dirs for sync there).
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

	// Track whether we've already cleaned the tmp file. If rename
	// succeeds the tmp no longer exists; otherwise the deferred Remove
	// is the safety net for any error path (including panics).
	renamed := false
	defer func() {
		if !renamed {
			_ = os.Remove(tmp)
		}
	}()

	f, err := os.OpenFile(tmp, os.O_RDWR|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return fmt.Errorf("open tmp %s: %w", tmp, err)
	}
	if _, err := f.Write([]byte(content)); err != nil {
		_ = f.Close()
		return fmt.Errorf("write tmp %s: %w", tmp, err)
	}
	// fsync the file's contents to disk before the rename so a
	// power-cut between rename and writeback can't leave the
	// destination with zero bytes. Windows' Sync is implemented as a
	// FlushFileBuffers call which is also fine, but cheaper to skip
	// since NTFS recovery handles small-file durability differently.
	if runtime.GOOS != "windows" {
		if err := f.Sync(); err != nil {
			_ = f.Close()
			return fmt.Errorf("fsync tmp %s: %w", tmp, err)
		}
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("close tmp %s: %w", tmp, err)
	}

	if err := os.Rename(tmp, filePath); err != nil {
		// Defer will unlink the staged tmp.
		return fmt.Errorf("rename %s -> %s: %w", tmp, filePath, err)
	}
	renamed = true

	if opts != nil && opts.Mode != 0 && runtime.GOOS != "windows" {
		// macOS' HFS / some APFS configurations preserve the
		// destination inode's metadata across rename, silently
		// downgrading the mode we set on the staged tmp. Re-apply.
		_ = os.Chmod(filePath, opts.Mode)
	}

	// fsync the parent directory so the rename is durable. Windows
	// can't open directories for sync — skip there. Errors are
	// best-effort: a failure to fsync the dir doesn't undo the write,
	// and the file fsync above is the more critical durability gate.
	if runtime.GOOS != "windows" {
		if d, derr := os.Open(dir); derr == nil {
			_ = d.Sync()
			_ = d.Close()
		}
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
