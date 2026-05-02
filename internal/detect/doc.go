// Package detect computes a per-task DetectedScope: which sibling
// repo(s) the task touches, what high-level features / domain entities
// it references, and any explicit file-path mentions in the body.
//
// The scope is rendered into both the coordinator prompt and every
// child prompt via Render so the two layers can never drift, and is
// persisted in sessions/<task-id>/meta.json under `detectedScope` so
// repeat dispatches don't re-run detection.
//
// Migration note: the TypeScript module shipped a heuristic +
// LLM-backed detector pair plus an `auto` mode that tried the LLM
// first and fell back to heuristic. The Go port is heuristic-only
// for now — the LLM client + bridge.json `detect.source` plumbing
// land in a follow-up. Mode and Source are preserved as types so the
// LLM upgrade can drop in without breaking on-disk meta.json or
// caller signatures.
//
// (The placeholder doc this file replaced described an "Add app"
// auto-detect flow — that flow lives in internal/apps now and never
// shipped under this package name.)
package detect
