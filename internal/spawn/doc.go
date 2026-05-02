// Package spawn orchestrates child Claude Code processes: spawn,
// stdout/stderr capture into per-session log files, retry with
// exponential backoff, stale-run reaping, and graceful shutdown.
//
// Cross-platform process group handling lives in
// process_kill_windows.go (job objects) and process_kill_unix.go
// (setpgid + killpg) so killing a parent reliably reaps grandchildren.
package spawn
