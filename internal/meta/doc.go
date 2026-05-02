// Package meta is the source of truth for per-task runtime state on
// disk: sessions/<task-id>/meta.json. Provides atomic write
// (tempfile + rename) with a per-directory mutex so concurrent
// AppendRun / UpdateRun callers serialize cleanly.
//
// Ported from libs/atomicWrite.ts + libs/tasks.ts + libs/meta.ts in S09.
// Event subscription (SubscribeMeta / SubscribeMetaAll) lives here too
// so the SSE route in S12 can subscribe without depending on the
// per-route singleton stash the TS module used.
package meta
