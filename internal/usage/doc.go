// Package usage aggregates token + cost usage stats from session
// JSONL events, both per-task and across the whole bridge, for the
// /api/usage and /api/tasks/<id>/usage endpoints.
//
// Ported from libs/sessionUsage.ts + libs/usageStats.ts in S06. The
// quota panel from Anthropic's `/api/oauth/usage` endpoint is stubbed
// in this iteration (returns Quota.Error="not implemented") — full
// OAuth fetch + retry-after handling lands when the auth/credentials
// wiring is plumbed (S13/S14).
package usage
