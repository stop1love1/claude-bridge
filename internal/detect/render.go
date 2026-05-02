package detect

// Render a DetectedScope into a single canonical markdown block. Go
// port of libs/detect/render.ts.
//
// One renderer is used by both the coordinator prompt and every child
// prompt, so coordinator and children always see the SAME detected
// scope. This is the contract that closes the drift between the two
// layers.
//
// The block is intentionally compact — coordinator agents read it once
// and decide; children read it as background. We use sentence-shaped
// bullets rather than tables for tokenizer-friendliness.

import (
	"sort"
	"strings"

	"github.com/stop1love1/claude-bridge/internal/apps"
)

// RenderOptions tunes the rendered Markdown. Both fields are optional;
// the renderer degrades gracefully when either is empty.
type RenderOptions struct {
	// Profiles — per-repo profiles. One bullet per profile is appended
	// after the scope summary so the coordinator sees what each
	// candidate repo actually looks like.
	Profiles map[string]apps.RepoProfile
	// ForCoordinator — when true, append a longer "How to read this"
	// footer suitable for the coordinator prompt. Children get the
	// terse version.
	ForCoordinator bool
}

// Display caps for each section. Long enough that a real task fits;
// short enough that the rendered prompt doesn't drown the rest of the
// system instructions in repo names.
const (
	maxRepoLines = 8
	maxFeatures  = 12
	maxEntities  = 12
	maxFiles     = 8
)

// Render builds the `## Detected scope` markdown block. Pure
// function — no I/O.
//
// Output shape (sections marked OPT-IN are skipped when empty):
//
//	## Detected scope
//	- Source: heuristic | llm | user-pinned
//	- Confidence: high | medium | low
//	- Reason: <one-line>
//	### Repos
//	- <name> (score N) — <reason>     # OPT-IN
//	### Features                       # OPT-IN
//	### Entities                       # OPT-IN
//	### Files mentioned                # OPT-IN
//	### Repo profiles                  # OPT-IN, only when profiles passed
func Render(scope DetectedScope, opts RenderOptions) string {
	var b strings.Builder
	writeLine := func(s string) {
		b.WriteString(s)
		b.WriteByte('\n')
	}

	writeLine("## Detected scope")
	writeLine("")
	writeLine("- Source: `" + string(scope.Source) + "`")
	writeLine("- Confidence: `" + string(scope.Confidence) + "`")
	reason := scope.Reason
	if reason == "" {
		reason = "(none)"
	}
	writeLine("- Reason: " + reason)
	writeLine("")

	if len(scope.Repos) > 0 {
		writeLine("### Repos (in priority order)")
		writeLine("")
		shown := scope.Repos
		if len(shown) > maxRepoLines {
			shown = shown[:maxRepoLines]
		}
		for _, r := range shown {
			rReason := r.Reason
			if rReason == "" {
				rReason = "(no detail)"
			}
			writeLine("- **`" + r.Name + "`** (score " + itoa(r.Score) + ") — " + rReason)
		}
		if len(scope.Repos) > maxRepoLines {
			writeLine("- …and " + itoa(len(scope.Repos)-maxRepoLines) + " more (truncated).")
		}
		writeLine("")
	} else {
		writeLine("### Repos")
		writeLine("")
		writeLine("- (no candidate repo scored above zero — pick from the profiles below based on the task body itself)")
		writeLine("")
	}

	if len(scope.Features) > 0 {
		writeLine("### Features")
		writeLine("")
		shown := scope.Features
		if len(shown) > maxFeatures {
			shown = shown[:maxFeatures]
		}
		writeLine("- " + joinTicked(shown))
		if len(scope.Features) > maxFeatures {
			writeLine("- …and " + itoa(len(scope.Features)-maxFeatures) + " more.")
		}
		writeLine("")
	}

	if len(scope.Entities) > 0 {
		writeLine("### Entities")
		writeLine("")
		shown := scope.Entities
		if len(shown) > maxEntities {
			shown = shown[:maxEntities]
		}
		writeLine("- " + joinTicked(shown))
		if len(scope.Entities) > maxEntities {
			writeLine("- …and " + itoa(len(scope.Entities)-maxEntities) + " more.")
		}
		writeLine("")
	}

	if len(scope.Files) > 0 {
		writeLine("### Files mentioned")
		writeLine("")
		shown := scope.Files
		if len(shown) > maxFiles {
			shown = shown[:maxFiles]
		}
		for _, f := range shown {
			writeLine("- `" + f + "`")
		}
		if len(scope.Files) > maxFiles {
			writeLine("- …and " + itoa(len(scope.Files)-maxFiles) + " more.")
		}
		writeLine("")
	}

	// Repo profiles — only emitted when caller supplied them. The
	// coordinator passes them so it sees the full contract surface;
	// children typically don't need them since they only run in one
	// repo and already have its profile rendered separately.
	if len(opts.Profiles) > 0 {
		names := make([]string, 0, len(opts.Profiles))
		for n := range opts.Profiles {
			names = append(names, n)
		}
		sort.Strings(names)
		writeLine("### Repo profiles")
		writeLine("")
		for _, name := range names {
			p := opts.Profiles[name]
			summary := strings.TrimSpace(p.Summary)
			if summary == "" {
				summary = p.Name + " — (no summary)"
			}
			stack := "(unknown)"
			if len(p.Stack) > 0 {
				stack = strings.Join(p.Stack, ", ")
			}
			features := "(none detected)"
			if len(p.Features) > 0 {
				features = strings.Join(p.Features, ", ")
			}
			entrypoints := "(unknown)"
			if len(p.Entrypoints) > 0 {
				ep := p.Entrypoints
				if len(ep) > 4 {
					ep = ep[:4]
				}
				entrypoints = strings.Join(ep, ", ")
			}
			writeLine("- **" + p.Name + "** — " + summary + " Stack: " + stack + ". Features: " + features + ". Entrypoints: " + entrypoints + ".")
		}
		writeLine("")
	}

	if opts.ForCoordinator {
		writeLine("Treat the top repo as a starting recommendation — override only if the task body genuinely contradicts it (and explain the override in your final summary).")
		writeLine("")
	}

	// The TS port emitted the lines via Array.join("\n") with no
	// trailing newline. Match that so a meta.json round-trip of a
	// pre-rendered prompt fragment is bytewise identical across
	// implementations during the migration window.
	out := b.String()
	return strings.TrimRight(out, "\n")
}

// joinTicked renders a slice as backtick-wrapped, comma-joined items.
// Inlined here rather than reusing strings.Join + a map so the render
// cost stays one allocation per call.
func joinTicked(in []string) string {
	if len(in) == 0 {
		return ""
	}
	var b strings.Builder
	b.Grow(len(in) * 8)
	for i, s := range in {
		if i > 0 {
			b.WriteString(", ")
		}
		b.WriteByte('`')
		b.WriteString(s)
		b.WriteByte('`')
	}
	return b.String()
}
