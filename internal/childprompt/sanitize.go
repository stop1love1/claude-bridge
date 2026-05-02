package childprompt

import (
	"regexp"
	"strings"
)

// coordinatorBodyCap mirrors libs/childPrompt.ts COORDINATOR_BODY_CAP.
// 16 KB is enough for an exhaustive role-specific brief without giving
// a runaway coordinator the room to crowd out the rest of the prompt.
const coordinatorBodyCap = 16 * 1024

// fenceOpenerRE matches an opening (or closing) markdown fence at the
// start of a line: optional leading whitespace then ≥3 backticks. The
// `(?m)` flag makes `^` match at each newline so a fence anywhere in
// the body — not just at byte 0 — is rewritten.
var fenceOpenerRE = regexp.MustCompile("(?m)^(\\s*)(`{3,})")

// yourJobHeadingRE matches `## Your job` (and the 1-6 `#` variants).
// `(?im)` for case-insensitive multiline so `### YOUR JOB` is also
// caught. Word boundary on `Your job` so `Your jobless` doesn't false-
// positive into a defang.
var yourJobHeadingRE = regexp.MustCompile(`(?im)^(#{1,6})(\s+Your job\b)`)

// SanitizeCoordinatorBody trims and length-caps untrusted coordinator-
// authored markdown. We don't try deep escaping — the body is markdown
// embedded in markdown and the LLM is expected to read prose verbatim.
// The single defense is the byte cap so a runaway coordinator can't
// blow out the child's context window.
func SanitizeCoordinatorBody(body string) string {
	trimmed := strings.TrimSpace(body)
	if trimmed == "" {
		return "(coordinator did not provide a role-specific brief — work from the task body and your role label alone)"
	}
	if len(trimmed) <= coordinatorBodyCap {
		return trimmed
	}
	return trimmed[:coordinatorBodyCap] +
		"\n\n…(truncated by bridge — coordinator brief exceeded 16 KB cap)"
}

// SanitizeTaskBodyForFence neutralizes any line that would prematurely
// close the fenced code block we wrap `taskBody` in. Earlier ports
// used a zero-width-joiner injection that some LLM input normalizers
// strip; this version inserts a U+200B ZERO-WIDTH SPACE between the
// indent and the backticks AND prefixes a regular space so a markdown
// parser treats the line as plain text regardless of what the model
// does to the ZWSP.
func SanitizeTaskBodyForFence(body string) string {
	// "$1​ ​$2" — indent, ZWSP, space, ZWSP, backticks.
	return fenceOpenerRE.ReplaceAllString(body, "$1​ ​$2")
}

// SanitizeUserPromptContent defangs two markers that would otherwise
// let user-supplied task content hijack the coordinator template:
//
//  1. The `{{...}}` template placeholders — a body with the literal
//     text `{{TASK_BODY}}` could be substituted recursively if the
//     substitution order ever changed, leaking template state into
//     downstream prompts.
//  2. The `## Your job` splice marker — a body containing that line
//     would let `spliceScopeBlock` inject the detected-scope at an
//     attacker-chosen position.
//
// We replace the `{{`/`}}` with fullwidth braces (｛｛ ｝｝) — visually
// similar, still LLM-readable, but no template substitution matches
// — and inject a ZWSP after the leading hashes of any `Your job`
// heading so `strings.Contains("## Your job")` no longer matches.
func SanitizeUserPromptContent(input string) string {
	if input == "" {
		return ""
	}
	out := strings.ReplaceAll(input, "{{", "｛｛")
	out = strings.ReplaceAll(out, "}}", "｝｝")
	// "$1​$2" — leading hashes, ZWSP, original whitespace + label.
	out = yourJobHeadingRE.ReplaceAllString(out, "$1​$2")
	return out
}
