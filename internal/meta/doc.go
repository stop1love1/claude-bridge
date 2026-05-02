// Package meta provides atomic read/write for sessions/<task-id>/meta.json
// (tempfile + os.Rename + a single-writer file lock) so concurrent
// coordinator and lifecycle-hook updates don't lose-update each other.
package meta
