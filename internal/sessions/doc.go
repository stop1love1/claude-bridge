// Package sessions reads Claude Code's JSONL session files from
// ~/.claude/projects/<slug>/*.jsonl, exposes a list cache and an
// append-only event channel, and serves them through /api/sessions*.
package sessions
