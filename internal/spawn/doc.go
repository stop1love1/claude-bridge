// Package spawn orchestrates child Claude Code processes: spawn,
// stdout/stderr capture into per-session log files, registry tracking,
// graceful shutdown.
//
// Cross-platform process group handling lives in
// process_kill_windows.go (taskkill /F /T) and process_kill_unix.go
// (setpgid at spawn + killpg at terminate) so killing a parent
// reliably reaps grandchildren.
//
// Ported from libs/spawn.ts + libs/spawnRegistry.ts + libs/processKill.ts
// in S07. The stream-json stdout parser (partial / status events) ports
// later — it's only needed once the SSE tail/stream route lands (S12).
// Retry ladder + stale-run reaper + shutdown handler are S08.
package spawn
