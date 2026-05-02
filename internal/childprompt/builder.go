// Package childprompt builds the standardized markdown prompt the
// bridge wraps around every child agent spawn (POST /api/tasks/<id>/agents).
// The coordinator only writes the role-specific brief — every other
// section (header, language, repo profile, pre-warmed context, self-
// register snippet, report contract) is produced here.
//
// Section order is contract: the coordinator's report aggregator parses
// each child's report by section header, and children rely on this
// wrapper's structure to know what's expected. Additions are
// append-only; never reorder, never rename a heading.
//
// Pure stdlib, no I/O. Caller is responsible for:
//   - resolving paths (BridgeURL + BridgeFolder via Options),
//   - loading optional context (RepoProfile, SymbolIndex, etc.) and
//     handing them in nil/empty when not available.
//
// See the TS source at libs/childPrompt.ts for the original contract.
package childprompt

import (
	"strings"

	"github.com/stop1love1/claude-bridge/internal/apps"
	"github.com/stop1love1/claude-bridge/internal/memory"
	"github.com/stop1love1/claude-bridge/internal/quality"
	"github.com/stop1love1/claude-bridge/internal/symbol"
)

// AppVerify is the per-app verify-command contract surfaced in the
// `## Verify commands` section. Placeholder — once internal/apps
// exposes a typed AppVerify (currently the bridge.json round-trip code
// uses a map[string]string), this struct can collapse into that.
type AppVerify struct {
	Format    string
	Lint      string
	Typecheck string
	Test      string
	Build     string
}

// DetectedScope is the cached scope decision the coordinator and child
// agents both render. Placeholder until internal/detect lands — the
// fields here are the union of what the renderer consumes; the wider
// contract (cache hashing, source tagging) lives in libs/detect/types.ts
// and will move to internal/detect when ported.
type DetectedScope struct {
	// Source identifies which detector impl produced this scope —
	// `heuristic`, `llm`, or `user-pinned`. Surfaced verbatim in the
	// prompt so a child agent can weight its trust appropriately.
	Source string
	// Confidence is `high` / `medium` / `low`; the coordinator gates
	// auto-dispatch on it.
	Confidence string
	// Reason is a one-line human-readable summary — heuristic shows
	// keyword hits, llm shows the model's reasoning.
	Reason string
	// Repos is sorted by score descending; Repos[0] is the dispatch
	// target.
	Repos []ScopeRepo
	// Features / Entities / FilesOfInterest carry the scope metadata
	// rendered as bullet sub-sections.
	Features        []string
	Entities        []string
	FilesOfInterest []string
}

// ScopeRepo is one candidate repo with its score + the human-readable
// reason it scored that high. Score is detector-specific — only
// comparable within a single DetectedScope.
type ScopeRepo struct {
	Name   string
	Score  int
	Reason string
}

// Options mirrors libs/childPrompt.ts BuildChildPromptOpts. Optional
// inputs use pointers (RepoProfile, AppVerify, etc.) or nil-able slices
// so the caller signals "skip this section" by passing nil/empty.
type Options struct {
	// Required identity / routing fields.
	TaskID          string
	TaskTitle       string
	TaskBody        string
	ParentSessionID string
	ChildSessionID  string
	Role            string
	Repo            string
	RepoCwd         string

	// BridgeURL is the absolute base URL the child curl-snippets and
	// fallback profile-refresh hint reference. Caller MUST set this
	// explicitly — the default `http://127.0.0.1:8080` is only useful
	// for the local-dev single-machine case.
	BridgeURL string
	// BridgeFolder is the directory name the child writes its report
	// under (`../<bridgeFolder>/sessions/<task-id>/reports/...`). Caller
	// MUST set this explicitly — defaults to `filepath.Base(cwd)` are
	// fine for local-dev, but a wrong value here breaks the report path
	// and the bridge stops seeing child output.
	BridgeFolder string

	// ContextBlock is the pre-warmed repo context (git status / log /
	// ls-files). Empty string = bridge skipped pre-warm.
	ContextBlock string
	// CoordinatorBody is the role-specific instructions the coordinator
	// wrote. Untrusted — gets passed through SanitizeCoordinatorBody.
	CoordinatorBody string
	// Profile is the cached repo profile for the target repo. nil =
	// fall back to the "no profile cached" pointer.
	Profile *apps.RepoProfile

	// HouseRules is the pre-loaded global+per-app `house-rules.md`
	// markdown. Empty string = section skipped.
	HouseRules string
	// PlaybookBody is the pre-loaded `prompts/playbooks/<role>.md`
	// markdown. Empty string = render only the coordinator brief.
	PlaybookBody string
	// VerifyHint is the per-app verify contract. nil = section skipped.
	VerifyHint *AppVerify
	// SymbolIndex is the per-app symbol index. nil = section skipped.
	SymbolIndex *symbol.SymbolIndex
	// StyleFingerprint is the auto-detected style fingerprint. nil =
	// section skipped.
	StyleFingerprint *quality.StyleFingerprint
	// PinnedFiles are the operator-pinned files. Empty = section
	// skipped.
	PinnedFiles []memory.PinnedFile
	// AttachedReferences are the auto-attached reference files. Empty
	// = section skipped.
	AttachedReferences []memory.ReferenceFile
	// RecentDirection is the recent-git-activity window. nil or
	// zero-Dir = section skipped.
	RecentDirection *memory.RecentDirection
	// MemoryEntries are durable rules accreted from prior tasks. Empty
	// = section skipped.
	MemoryEntries []string
	// DetectedScope is the cached scope decision. nil = section skipped.
	DetectedScope *DetectedScope
	// SharedPlan is the contents of `sessions/<task-id>/plan.md` if a
	// planner agent has already drafted one. Empty = section skipped.
	SharedPlan string
}

// Build renders the full child prompt. Pure function — no I/O. See the
// section ordering contract at the top of libs/childPrompt.ts.
func Build(opts Options) string {
	safeBody := SanitizeCoordinatorBody(opts.CoordinatorBody)
	safeTaskBody := SanitizeTaskBodyForFence(opts.TaskBody)
	profileLine := renderProfileLine(opts.Profile, opts.BridgeURL)
	ctx := strings.TrimSpace(opts.ContextBlock)
	if ctx == "" {
		ctx = "(none — bridge skipped pre-warm)"
	}

	var b strings.Builder

	// 1. Header — role / task / repo / dispatcher disclaimer. Single
	//    paragraph so a long role/task title doesn't sprawl into the
	//    structural sections below.
	b.WriteString("You are a `")
	b.WriteString(opts.Role)
	b.WriteString("` agent dispatched by the bridge coordinator for task `")
	b.WriteString(opts.TaskID)
	b.WriteString("`. You run inside `")
	b.WriteString(opts.Repo)
	b.WriteString("` (cwd resolves to `")
	b.WriteString(opts.RepoCwd)
	b.WriteString("`). You are NOT the coordinator — your job is the specific task below; you do not orchestrate, you do not spawn other agents, you produce one report and exit.\n\n")

	// 2. Language directive — every reply mirrors the task body's
	//    language; identifier-level text stays English.
	b.WriteString("## Language\n\n")
	b.WriteString("Mirror the language of the task body (whatever it is) in every reply, code comment narration, and the final report. Identifier-level text (file paths, function names, JSON keys, shell commands) stays in English.\n\n")

	// 3. House rules (OPT-IN).
	houseRules := strings.TrimSpace(opts.HouseRules)
	if houseRules != "" {
		b.WriteString("## House rules\n\n")
		b.WriteString("Team constraints that apply to every change in this codebase. Treat as hard requirements — violating one means the work will be rejected at review.\n\n")
		b.WriteString(houseRules)
		b.WriteString("\n\n")
	}

	// 4. House style auto-detected (OPT-IN).
	styleLines := renderStyleFingerprintLines(opts.StyleFingerprint)
	if len(styleLines) > 0 {
		b.WriteString("## House style (auto-detected)\n\n")
		b.WriteString("Match these conventions in any new or edited code. Auto-detected from a sample of the codebase, so they reflect what the team actually writes — not a stale style guide. Mismatches won't fail the build but will read as alien.\n\n")
		writeLines(&b, styleLines)
		b.WriteString("\n")
	}

	// 5. Memory (OPT-IN).
	if len(opts.MemoryEntries) > 0 {
		b.WriteString("## Memory (learnings from prior tasks in this app)\n\n")
		b.WriteString("Durable rules accreted from past tasks in this app. Treat each as a soft requirement — the team chose to remember it for a reason. Only deviate when the current task body explicitly overrides.\n\n")
		for _, e := range opts.MemoryEntries {
			if strings.HasPrefix(e, "-") {
				b.WriteString(e)
			} else {
				b.WriteString("- ")
				b.WriteString(e)
			}
			b.WriteString("\n")
		}
		b.WriteString("\n")
	}

	// 6. Task — wrapped in a fenced block. The body is sanitized to
	//    keep an embedded ``` from closing our wrapper fence.
	b.WriteString("## Task\n\n")
	b.WriteString("- ID: `")
	b.WriteString(opts.TaskID)
	b.WriteString("`\n- Title: ")
	b.WriteString(opts.TaskTitle)
	b.WriteString("\n- Original body (verbatim from the user):\n\n  ```\n")
	b.WriteString(safeTaskBody)
	b.WriteString("\n  ```\n\n")

	// 7. Detected scope (OPT-IN).
	if opts.DetectedScope != nil {
		b.WriteString(renderDetectedScope(opts.DetectedScope))
		b.WriteString("\n")
	}

	// 8. Shared plan (OPT-IN).
	sharedPlan := strings.TrimSpace(opts.SharedPlan)
	if sharedPlan != "" {
		b.WriteString("## Shared plan (from planner)\n\n")
		b.WriteString("A planner agent already drafted the cross-repo breakdown and contracts for this task. **Treat the contracts as authoritative** — if your role would deviate from a documented contract, stop and surface that as a `NEEDS-DECISION` instead of silently going your own way (the other repo's coder is reading the same plan and assuming you'll follow it). The work breakdown and conventions are guidance — match them when reasonable, deviate with a one-line note in your report when you find new info that invalidates an assumption.\n\n")
		b.WriteString(sharedPlan)
		b.WriteString("\n\n")
	}

	// 9. Your role — playbook (if any) prepended to the coordinator
	//    brief inside one bracketed section.
	b.WriteString("## Your role\n\n`")
	b.WriteString(opts.Role)
	b.WriteString("` in `")
	b.WriteString(opts.Repo)
	b.WriteString("`. The coordinator wrote the role-specific brief below — read it carefully:\n\n---\n\n")

	playbook := strings.TrimSpace(opts.PlaybookBody)
	if playbook != "" {
		b.WriteString("**Role playbook (`")
		b.WriteString(opts.Role)
		b.WriteString("`):**\n\n")
		b.WriteString(playbook)
		b.WriteString("\n\n---\n\n**Task-specific brief (from coordinator):**\n\n")
	}

	b.WriteString(safeBody)
	b.WriteString("\n\n---\n\n")

	// 10. Repo profile.
	b.WriteString("## Repo profile\n\n")
	b.WriteString(profileLine)
	b.WriteString("\n\n")

	// 11. Available helpers (OPT-IN).
	symbolLines := renderSymbolIndexLines(opts.SymbolIndex)
	if len(symbolLines) > 0 {
		b.WriteString("## Available helpers\n\n")
		b.WriteString("Top-level exports already in this codebase. Reuse these instead of writing a new utility — duplicating an existing helper is the fastest way to ship code that reads as alien. Auto-extracted from `lib/`, `utils/`, `hooks/`, `components/ui/` (override via `bridge.json.symbolDirs`).\n\n")
		writeLines(&b, symbolLines)
		b.WriteString("\n")
	}

	// 12. Repo context.
	b.WriteString("## Repo context (auto-captured by bridge)\n\n")
	b.WriteString(ctx)
	b.WriteString("\n\n")

	// 13. Recent direction (OPT-IN).
	recentLines := renderRecentDirectionLines(opts.RecentDirection)
	if len(recentLines) > 0 {
		b.WriteString("## Recent direction\n\n")
		b.WriteString("Last 10 commits that touched the dir the task is most likely focused on. Use this to see what conventions are being established right now (the static profile data above can lag a refactor by days).\n\n")
		writeLines(&b, recentLines)
		b.WriteString("\n")
	}

	// 14. Pinned context (OPT-IN).
	pinnedLines := renderPinnedFilesLines(opts.PinnedFiles)
	if len(pinnedLines) > 0 {
		b.WriteString("## Pinned context\n\n")
		b.WriteString("Files the operator pinned for this app — canonical examples, type files, routing manifests. Treat them as authoritative for shape and convention; if your work needs to differ, justify in your report.\n\n")
		writeLines(&b, pinnedLines)
		b.WriteString("\n")
	}

	// 15. Reference files (OPT-IN).
	referenceLines := renderReferenceFilesLines(opts.AttachedReferences)
	if len(referenceLines) > 0 {
		b.WriteString("## Reference files\n\n")
		b.WriteString("Files the bridge auto-picked based on task-body keyword overlap with the symbol index. These are the **closest examples already in the codebase** to what the task is asking for — match their patterns. Lower-priority than `## Pinned context` (operator-curated) but higher-signal than the rest of the repo.\n\n")
		writeLines(&b, referenceLines)
		b.WriteString("\n")
	}

	// 16. Self-register — confirms the bridge's pre-registered run is
	//     live. Single curl POST; the lifecycle hook handles the
	//     terminal status flip.
	b.WriteString("## Self-register\n\n")
	b.WriteString("Your session UUID is `")
	b.WriteString(opts.ChildSessionID)
	b.WriteString("` — already passed via `--session-id`. The bridge has pre-registered your run in `meta.json`. Confirm registration once via:\n\n")
	b.WriteString("```bash\ncurl -s -X POST ")
	b.WriteString(opts.BridgeURL)
	b.WriteString("/api/tasks/")
	b.WriteString(opts.TaskID)
	b.WriteString("/link \\\n")
	b.WriteString("  -H \"content-type: application/json\" \\\n")
	b.WriteString("  -H \"x-bridge-internal-token: $BRIDGE_INTERNAL_TOKEN\" \\\n")
	b.WriteString("  -d '{\"sessionId\":\"")
	b.WriteString(opts.ChildSessionID)
	b.WriteString("\",\"role\":\"")
	b.WriteString(opts.Role)
	b.WriteString("\",\"repo\":\"")
	b.WriteString(opts.Repo)
	b.WriteString("\",\"status\":\"running\"}'\n```\n\n")
	b.WriteString("**Do NOT re-POST `status:\"done\"` at the end.** The bridge's lifecycle hook flips your run from `running → done` automatically when this turn ends cleanly (or `failed` on non-zero exit). Self-POSTing `done` while you're still streaming the final summary makes the UI show DONE before the user sees your reply. The only legitimate self-POST is the initial `running` confirmation above.\n\n")

	// 17. Report contract — the parser-load-bearing section. Schema is
	//     verbatim because the coordinator's aggregator splits on these
	//     exact headings.
	b.WriteString("## Report contract — REQUIRED\n\n")
	b.WriteString("**Escalation rule — read this first.** If the task body is ambiguous, you face a multi-option choice, or you need approval before proceeding: **DO NOT guess.** Stop, set verdict to `NEEDS-DECISION`, fill `## Questions for the user` with concrete options + your recommendation, and exit cleanly. The coordinator forwards the questions to the user; once answered, the bridge re-dispatches you (or a sibling) with the answers in the new prompt. Guessing past ambiguity wastes a retry slot and ships work the user has to redo.\n\n")
	b.WriteString("Before you exit, write `../")
	b.WriteString(opts.BridgeFolder)
	b.WriteString("/sessions/")
	b.WriteString(opts.TaskID)
	b.WriteString("/reports/")
	b.WriteString(opts.Role)
	b.WriteString("-")
	b.WriteString(opts.Repo)
	b.WriteString(".md` (`mkdir -p` the dir first). Use this exact schema:\n\n")
	b.WriteString("```markdown\n# ")
	b.WriteString(opts.Role)
	b.WriteString(" @ ")
	b.WriteString(opts.Repo)
	b.WriteString("\n\n## Verdict\nDONE | BLOCKED | PARTIAL | NEEDS-DECISION — one line, no extra prose.\n- BLOCKED → the next section MUST start with `BLOCK: <reason>` so the bridge auto-retry path can read it.\n- NEEDS-DECISION → fill `## Questions for the user` below; skip `## Changed files` / `## How to verify` (write `(none — awaiting decision)`).\n\n## Summary\n2–4 sentences in the user's language describing what shipped end-to-end. No raw logs.\n\n## Questions for the user\n(Only required when verdict is `NEEDS-DECISION`. Otherwise omit, or write `(none)`.)\nFor each open decision, one bullet group:\n- **Q1:** the question in one sentence.\n  - Context: 1–2 lines on why it matters / what depends on it.\n  - Options: `(a) …` `(b) …` `(c) …` (concrete, mutually exclusive).\n  - Recommendation: which option you'd pick and why, in one sentence.\n\n## Changed files\n- `<path>` — one-line description of the change.\n(Bullet per file. If you only ran read-only analysis, write `(none — analysis only)` and proceed.)\n\n## How to verify\nConcrete steps a human can run to confirm the work: a curl, a test command, a screen to open. 1–3 bullets.\n\n## Risks / out-of-scope\n- Risks introduced by this change.\n- Things adjacent to the task that you deliberately did not touch.\n(Either bullet list, or write `(none)` for both.)\n\n## Notes for the coordinator\nAnything the coordinator should know when aggregating: cross-repo dependencies surfaced (`NEEDS-OTHER-SIDE: <thing>`), hidden gotchas, follow-up tasks worth filing. If verdict is `NEEDS-DECISION`, flag which question is blocking the most work.\n```\n\n")
	b.WriteString("The coordinator parses these section headers exactly. Stick to the schema — adding sections is fine, removing or renaming is NOT.\n\n")
	b.WriteString("**Strict end-of-turn order:**\n1. Write the report file under `sessions/<task-id>/reports/`.\n2. Send your final assistant message mirroring the report's `## Summary` section.\n3. Stop. No more tool calls, no link re-POST, no status PATCH.\n\n")
	b.WriteString("Tool calls AFTER the chat reply land in the UI as trailing noise; status PATCHes flip the visible badge to DONE while you're still typing. Let the bridge's lifecycle hook close the run.\n\n")
	b.WriteString("**Git is bridge-managed.** Do NOT run `git checkout`, `git commit`, or `git push` yourself — the bridge already prepared the branch before your spawn and will (if the app is configured for it) auto-commit + auto-push after you exit cleanly. Duplicating those commands races the lifecycle hook and produces empty / conflicting commits. Write code, write the report, exit.\n\n")

	// 18. Verify commands (OPT-IN).
	verifyEntries := renderVerifyEntries(opts.VerifyHint)
	if len(verifyEntries) > 0 {
		b.WriteString("## Verify commands\n\n")
		b.WriteString("Run these locally before writing your report. Each one is the team's source of truth for `it works` — your report's `## How to verify` section should reference them. P2 of the bridge will exec these automatically; for now, running them yourself catches problems before the report goes out.\n\n")
		writeLines(&b, verifyEntries)
		b.WriteString("\n")
	}

	// 19. Spawn-time signals — small footer with the parent linkage so
	//     the child can cross-reference in its report.
	b.WriteString("## Spawn-time signals\n\n")
	b.WriteString("- Bridge heuristic suggested target repo: `")
	b.WriteString(opts.Repo)
	b.WriteString("` (this is you).\n")
	b.WriteString("- Parent coordinator session: `")
	b.WriteString(opts.ParentSessionID)
	b.WriteString("` — for cross-referencing in your report.\n")

	return b.String()
}

// writeLines flushes pre-built bullet/code lines into the running
// builder. Each line gets one trailing newline; the caller adds the
// final blank line for spacing.
func writeLines(b *strings.Builder, lines []string) {
	for _, l := range lines {
		b.WriteString(l)
		b.WriteString("\n")
	}
}

// renderProfileLine formats a RepoProfile as a one-bullet line. Falls
// back to a refresh hint when no profile is cached — the prompt still
// renders, just without the contextual bullet.
func renderProfileLine(p *apps.RepoProfile, bridgeURL string) string {
	if p == nil {
		return "(no profile cached — call `GET " + bridgeURL + "/api/repos/profiles` to refresh)"
	}
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
		take := p.Entrypoints
		if len(take) > 4 {
			take = take[:4]
		}
		entrypoints = strings.Join(take, ", ")
	}
	return "- **" + p.Name + "** — " + summary + " Stack: " + stack +
		". Features: " + features + ". Entrypoints: " + entrypoints + "."
}

// renderDetectedScope mirrors libs/detect/render.ts renderDetectedScope
// in `forCoordinator: false` mode — children see the terse version
// without the "How to read this" footer.
func renderDetectedScope(scope *DetectedScope) string {
	const (
		maxRepoLines = 8
		maxFeatures  = 12
		maxEntities  = 12
		maxFiles     = 8
	)
	var b strings.Builder
	b.WriteString("## Detected scope\n\n")
	b.WriteString("- Source: `")
	b.WriteString(scope.Source)
	b.WriteString("`\n- Confidence: `")
	b.WriteString(scope.Confidence)
	b.WriteString("`\n- Reason: ")
	if scope.Reason == "" {
		b.WriteString("(none)")
	} else {
		b.WriteString(scope.Reason)
	}
	b.WriteString("\n\n")

	if len(scope.Repos) > 0 {
		b.WriteString("### Repos (in priority order)\n\n")
		shown := scope.Repos
		if len(shown) > maxRepoLines {
			shown = shown[:maxRepoLines]
		}
		for _, r := range shown {
			b.WriteString("- **`")
			b.WriteString(r.Name)
			b.WriteString("`** (score ")
			b.WriteString(itoa(r.Score))
			b.WriteString(") — ")
			if r.Reason == "" {
				b.WriteString("(no detail)")
			} else {
				b.WriteString(r.Reason)
			}
			b.WriteString("\n")
		}
		if len(scope.Repos) > maxRepoLines {
			b.WriteString("- …and ")
			b.WriteString(itoa(len(scope.Repos) - maxRepoLines))
			b.WriteString(" more (truncated).\n")
		}
		b.WriteString("\n")
	} else {
		b.WriteString("### Repos\n\n")
		b.WriteString("- (no candidate repo scored above zero — pick from the profiles below based on the task body itself)\n\n")
	}

	if len(scope.Features) > 0 {
		b.WriteString("### Features\n\n- ")
		writeBacktickedJoin(&b, scope.Features, maxFeatures)
		b.WriteString("\n")
		if len(scope.Features) > maxFeatures {
			b.WriteString("- …and ")
			b.WriteString(itoa(len(scope.Features) - maxFeatures))
			b.WriteString(" more.\n")
		}
		b.WriteString("\n")
	}

	if len(scope.Entities) > 0 {
		b.WriteString("### Entities\n\n- ")
		writeBacktickedJoin(&b, scope.Entities, maxEntities)
		b.WriteString("\n")
		if len(scope.Entities) > maxEntities {
			b.WriteString("- …and ")
			b.WriteString(itoa(len(scope.Entities) - maxEntities))
			b.WriteString(" more.\n")
		}
		b.WriteString("\n")
	}

	if len(scope.FilesOfInterest) > 0 {
		b.WriteString("### Files mentioned\n\n")
		shown := scope.FilesOfInterest
		if len(shown) > maxFiles {
			shown = shown[:maxFiles]
		}
		for _, f := range shown {
			b.WriteString("- `")
			b.WriteString(f)
			b.WriteString("`\n")
		}
		if len(scope.FilesOfInterest) > maxFiles {
			b.WriteString("- …and ")
			b.WriteString(itoa(len(scope.FilesOfInterest) - maxFiles))
			b.WriteString(" more.\n")
		}
		b.WriteString("\n")
	}

	return b.String()
}

// writeBacktickedJoin renders a comma-joined list with each element
// wrapped in single backticks — used by the scope features/entities
// sub-sections.
func writeBacktickedJoin(b *strings.Builder, items []string, max int) {
	shown := items
	if len(shown) > max {
		shown = shown[:max]
	}
	for i, s := range shown {
		if i > 0 {
			b.WriteString(", ")
		}
		b.WriteByte('`')
		b.WriteString(s)
		b.WriteByte('`')
	}
}

// itoa is a tiny int→string helper. We avoid strconv just to keep the
// imports list short — the only ints rendered here are bounded scope
// counts.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

// verifyOrder is the canonical ordering for the verify-commands
// section — typecheck first because it's the cheapest and catches the
// largest class of churn.
var verifyOrder = []struct {
	get   func(*AppVerify) string
	label string
}{
	{func(v *AppVerify) string { return v.Typecheck }, "Typecheck"},
	{func(v *AppVerify) string { return v.Lint }, "Lint"},
	{func(v *AppVerify) string { return v.Format }, "Format"},
	{func(v *AppVerify) string { return v.Test }, "Test"},
	{func(v *AppVerify) string { return v.Build }, "Build"},
}

// renderVerifyEntries returns one bullet per non-empty AppVerify field
// in the canonical order. Empty input or all-empty fields return nil
// so the caller can skip the section header entirely.
func renderVerifyEntries(v *AppVerify) []string {
	if v == nil {
		return nil
	}
	var out []string
	for _, e := range verifyOrder {
		cmd := strings.TrimSpace(e.get(v))
		if cmd != "" {
			out = append(out, "- **"+e.label+"** — `"+cmd+"`")
		}
	}
	return out
}

// symbolsPromptCap caps the helper-bullets in the prompt so a 400-
// symbol index doesn't dominate the spawn token budget. The trailing
// "+N more" line tells the agent how many were truncated.
const symbolsPromptCap = 30

// renderSymbolIndexLines groups the symbol index by file with
// components surfaced first. nil/empty index returns nil so the
// caller can skip the section header.
func renderSymbolIndexLines(index *symbol.SymbolIndex) []string {
	if index == nil || len(index.Symbols) == 0 {
		return nil
	}
	// Stable sort: components first, then file path, then name.
	// Copy the slice — the index is shared state, mutating it would
	// reorder fields the caller may inspect later.
	sorted := make([]symbol.SymbolEntry, len(index.Symbols))
	copy(sorted, index.Symbols)
	sortSymbolEntries(sorted)

	shown := sorted
	if len(shown) > symbolsPromptCap {
		shown = shown[:symbolsPromptCap]
	}
	extra := len(sorted) - len(shown)

	var out []string
	lastFile := ""
	for _, s := range shown {
		if s.File != lastFile {
			if lastFile != "" {
				out = append(out, "")
			}
			out = append(out, "From `"+s.File+"`:")
			lastFile = s.File
		}
		sigSuffix := ""
		if s.Signature != "" {
			sigSuffix = " — `" + s.Signature + "`"
		}
		out = append(out, "- `"+s.Name+"` *("+string(s.Kind)+")*"+sigSuffix)
	}
	if extra > 0 {
		out = append(out, "", "…and **"+itoa(extra)+"** more — full list in `.bridge-state/symbol-indexes.json`.")
	}
	return out
}

// sortSymbolEntries sorts in place: components before non-components,
// then file alpha, then name alpha. Stable so equal-keyed entries
// preserve input order.
func sortSymbolEntries(entries []symbol.SymbolEntry) {
	// Insertion sort — stable, fits the small per-app index sizes
	// (typically ≤ 400 entries from internal/symbol's symbolCap).
	for i := 1; i < len(entries); i++ {
		j := i
		for j > 0 && symbolLess(entries[j], entries[j-1]) {
			entries[j], entries[j-1] = entries[j-1], entries[j]
			j--
		}
	}
}

func symbolLess(a, b symbol.SymbolEntry) bool {
	aComp := a.Kind != symbol.KindComponent
	bComp := b.Kind != symbol.KindComponent
	if aComp != bComp {
		// false (component) sorts before true.
		return !aComp
	}
	if a.File != b.File {
		return a.File < b.File
	}
	return a.Name < b.Name
}

// renderStyleFingerprintLines renders 5–7 short bullets. Each
// dimension that came back "unknown" is omitted — `unknown` advice is
// worse than no advice. Empty result = caller skips the section.
func renderStyleFingerprintLines(fp *quality.StyleFingerprint) []string {
	if fp == nil {
		return nil
	}
	var out []string

	switch fp.Indent.Kind {
	case "spaces":
		out = append(out, "- Indent: **"+itoa(fp.Indent.Width)+" spaces**")
	case "tabs":
		out = append(out, "- Indent: **tabs**")
	}
	if fp.Quotes != "unknown" && fp.Quotes != "" {
		var label string
		switch fp.Quotes {
		case "single":
			label = "single (`'…'`)"
		case "double":
			label = "double (`\"…\"`)"
		default:
			label = "mixed (no clear preference)"
		}
		out = append(out, "- String quotes: "+label)
	}
	if fp.Semicolons != "unknown" && fp.Semicolons != "" {
		var label string
		switch fp.Semicolons {
		case "always":
			label = "always — terminate every statement"
		case "never":
			label = "never — ASI, no trailing semicolons"
		default:
			label = "mixed (no clear preference)"
		}
		out = append(out, "- Semicolons: "+label)
	}
	if fp.TrailingComma != "unknown" && fp.TrailingComma != "" {
		var label string
		switch fp.TrailingComma {
		case "all":
			label = "always (multi-line lists)"
		case "none":
			label = "never"
		default:
			label = "mixed"
		}
		out = append(out, "- Trailing commas: "+label)
	}
	if fp.Exports != "unknown" && fp.Exports != "" {
		var label string
		switch fp.Exports {
		case "named":
			label = "**named exports** preferred (default exports rare)"
		case "default":
			label = "**default exports** preferred"
		default:
			label = "mixed (named + default both common)"
		}
		out = append(out, "- Module exports: "+label)
	}
	if fp.FileNaming.Tsx != "unknown" && fp.FileNaming.Tsx != "" {
		out = append(out, "- `.tsx` file naming: **"+fp.FileNaming.Tsx+"**")
	}
	if fp.FileNaming.Ts != "unknown" && fp.FileNaming.Ts != "" && fp.FileNaming.Ts != fp.FileNaming.Tsx {
		out = append(out, "- `.ts` file naming: **"+fp.FileNaming.Ts+"**")
	}

	if len(out) == 0 {
		return nil
	}
	out = append(out, "", "_Detected from "+itoa(fp.SampledFiles)+" file(s); refresh after major refactors via the apps page._")
	return out
}

// renderPinnedFilesLines emits one fenced block per pinned file with
// the file rel as a sub-heading. The fence language is inferred from
// the extension so the LLM tokenizer treats the body as code.
func renderPinnedFilesLines(files []memory.PinnedFile) []string {
	if len(files) == 0 {
		return nil
	}
	var out []string
	for i, f := range files {
		if i > 0 {
			out = append(out, "")
		}
		lang := inferLang(f.Rel)
		out = append(out, "### `"+f.Rel+"`", "", "```"+lang, f.Content)
		if f.Truncated {
			out = append(out, "…(bridge: file truncated at 4 KB)")
		}
		out = append(out, "```")
	}
	return out
}

// renderReferenceFilesLines is the auto-attached twin of
// renderPinnedFilesLines. Adds a per-file score badge so the agent
// understands WHY each was attached.
func renderReferenceFilesLines(files []memory.ReferenceFile) []string {
	if len(files) == 0 {
		return nil
	}
	var out []string
	for i, f := range files {
		if i > 0 {
			out = append(out, "")
		}
		lang := inferLang(f.Rel)
		out = append(out,
			"### `"+f.Rel+"` _(score "+itoa(f.Score)+")_",
			"",
			"```"+lang,
			f.Content,
		)
		if f.Truncated {
			out = append(out, "…(bridge: file truncated at 4 KB)")
		}
		out = append(out, "```")
	}
	return out
}

// renderRecentDirectionLines emits one fenced block — "git log --stat"
// output for the auto-picked focus dir. nil or zero-Dir input returns
// nil so the caller skips the section.
func renderRecentDirectionLines(d *memory.RecentDirection) []string {
	if d == nil || d.Dir == "" {
		return nil
	}
	out := []string{
		"Focus dir: `" + d.Dir + "` (auto-picked from task body)",
		"",
		"```",
		d.Log,
	}
	if d.Truncated {
		out = append(out, "…(bridge: log truncated to 30 lines)")
	}
	out = append(out, "```")
	return out
}

// extToLang maps a lowercased file extension (no dot) to a fenced
// code-block language tag. Unknown extensions return "" — markdown
// renders an unspecified fence the same as a plain block, which is
// the right default for `.env` / config files / etc.
var extToLang = map[string]string{
	"ts": "ts", "tsx": "tsx", "js": "js", "jsx": "jsx",
	"mjs": "js", "cjs": "js",
	"json": "json", "md": "md", "yml": "yaml", "yaml": "yaml",
	"py": "python", "go": "go", "rs": "rust",
	"java": "java", "rb": "ruby",
	"sh": "bash", "css": "css", "html": "html",
}

func inferLang(file string) string {
	dot := strings.LastIndex(file, ".")
	if dot <= 0 {
		return ""
	}
	ext := strings.ToLower(file[dot+1:])
	return extToLang[ext]
}
