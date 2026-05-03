package memory

import (
	"strings"

	"github.com/stop1love1/claude-bridge/internal/meta"
)

// ResumeOptions bundles the per-turn inputs the resume prompt needs.
// Role / Repo / ParentSessionID come from the dispatch decision (not
// meta.json) because the same task can be resumed under different
// roles in different repos; CoordinatorBody is the operator-supplied
// follow-up brief for this specific turn.
//
// ParentSessionID uses string with an explicit "" sentinel rather
// than *string because the only consumer is BuildResumePrompt and the
// "(none — direct spawn)" branch already collapses the empty case;
// pointer chasing for a single string field would be busy work.
type ResumeOptions struct {
	Role            string
	Repo            string
	ParentSessionID string
	CoordinatorBody string
}

// BuildResumePrompt formats the message body the bridge hands to
// `claude --resume <sid>` for a follow-up turn. Mirrors
// libs/resumePrompt.ts buildResumePrompt — pure function, no I/O,
// no env reads.
//
// Why a dedicated builder (vs. reusing the spawn prompt builder):
// the original spawn writes a ~5 KB preamble (language directive,
// task body, repo profile, helpers, pinned files, recent direction,
// report contract, self-register snippet) into the child's first user
// message. Claude persists that whole prompt in the session's
// `.jsonl`, so on a `--resume` turn the model already has all of it
// in context. Re-emitting any of it would burn tokens for zero gain
// (worse: the child gets a contradictory second "task body" that
// doesn't match the first).
//
// The TaskID is read from meta so the builder stays in sync with the
// task header even if the dispatch path forgets to pass one — the
// resume turn always belongs to a meta-tracked task.
func BuildResumePrompt(m meta.Meta, opts ResumeOptions) string {
	trimmed := strings.TrimSpace(opts.CoordinatorBody)
	safeBody := trimmed
	if safeBody == "" {
		safeBody = "(coordinator did not provide a follow-up brief)"
	}

	var coordinatorLine string
	if opts.ParentSessionID != "" {
		coordinatorLine = "Coordinator session: `" + opts.ParentSessionID + "`."
	} else {
		coordinatorLine = "Coordinator session: (none — direct spawn)."
	}

	// Build with strings.Builder rather than a slice + Join because the
	// resume prompt is on the spawn hot path and a single growable
	// buffer beats a temporary slice + per-element copy.
	var b strings.Builder
	b.WriteString("**Follow-up turn — task `")
	b.WriteString(m.TaskID)
	b.WriteString("`, role `")
	b.WriteString(opts.Role)
	b.WriteString("` @ `")
	b.WriteString(opts.Repo)
	b.WriteString("`.**\n\n")
	b.WriteString(coordinatorLine)
	b.WriteString("\n\n")
	b.WriteString("Your prior context (task body, repo profile, helpers, report contract, self-register snippet) is already in this session's transcript — do NOT re-read or re-emit it. Just act on the brief below.\n\n")
	b.WriteString("---\n\n")
	b.WriteString(safeBody)
	b.WriteString("\n\n---\n\n")
	b.WriteString("**End-of-turn order (same as the original spawn):**\n")
	b.WriteString("1. Update or append to `sessions/")
	b.WriteString(m.TaskID)
	b.WriteString("/reports/")
	b.WriteString(opts.Role)
	b.WriteString("-")
	b.WriteString(opts.Repo)
	b.WriteString(".md` with this turn's findings.\n")
	b.WriteString("2. Send your final assistant message mirroring the new `## Summary`.\n")
	b.WriteString("3. Stop. Do not re-POST `status:\"done\"` — the bridge's lifecycle hook flips your run from running → done on clean exit. The only legitimate self-POST is `status:\"failed\"` if you abort early.\n\n")
	b.WriteString("Git is still bridge-managed: do not run `git checkout` / `commit` / `push` — auto-commit fires after you exit cleanly.")
	return b.String()
}
