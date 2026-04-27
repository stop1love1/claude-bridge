# Child agent report template

Every child agent spawned via `POST /api/tasks/<id>/agents` MUST write its report to `../<bridge-folder>/sessions/<task-id>/reports/<role>-<repo>.md` before exiting (`mkdir -p` the dir first), where `<bridge-folder>` is the basename of the bridge repo (the wrapper in `lib/childPrompt.ts` substitutes the actual name at spawn time, so children see the real path in their wrapped prompt). The coordinator parses these section headers exactly when aggregating — adding sections is fine, removing or renaming is NOT.

The wrapper in `lib/childPrompt.ts` (function `buildChildPrompt`) already injects this contract into every child prompt; this file is the canonical standalone copy that the coordinator can `cat bridge/report-template.md` to refresh its memory, and that future hooks (e.g., a CI lint) can read.

```markdown
# <role> @ <repo>

## Verdict
DONE | BLOCKED | PARTIAL | NEEDS-DECISION — one line, no extra prose.
- `BLOCKED` → next section MUST start with `BLOCK: <reason>` so the bridge auto-retry path can read it.
- `NEEDS-DECISION` → use this when the task body is ambiguous, you face a multi-option choice, or you need approval before proceeding. **Do NOT guess your way past it** — exit with this verdict, fill `## Questions for the user`, and let the coordinator escalate. Skip `## Changed files` / `## How to verify` (write `(none — awaiting decision)`).

## Summary
2–4 sentences in the user's language describing what shipped end-to-end. No raw logs.

## Questions for the user
(Only required when verdict is `NEEDS-DECISION`. Otherwise omit, or write `(none)`.)
For each open decision, one bullet group:
- **Q1:** the question in one sentence.
  - Context: 1–2 lines on why it matters / what depends on it.
  - Options: `(a) …` `(b) …` `(c) …` (concrete, mutually exclusive).
  - Recommendation: which option you'd pick and why, in one sentence.
The coordinator pastes these verbatim into the task summary so the user can answer in the bridge UI.

## Changed files
- `<path>` — one-line description of the change.
(Bullet per file. If you only ran read-only analysis, write `(none — analysis only)` and proceed.)

## How to verify
Concrete steps a human can run to confirm the work: a curl, a test command, a screen to open. 1–3 bullets.

## Risks / out-of-scope
- Risks introduced by this change.
- Things adjacent to the task that you deliberately did not touch.
(Either bullet list, or write `(none)` for both.)

## Notes for the coordinator
Anything the coordinator should know when aggregating: cross-repo dependencies surfaced (`NEEDS-OTHER-SIDE: <thing>`), hidden gotchas, follow-up tasks worth filing. If the verdict is `NEEDS-DECISION`, also note which question(s) are blocking the most work so the coordinator can prioritize.
```

After writing the report, the child does NOT call any more tools. The last assistant message mirrors the report's `## Summary` section so the user sees it in the chat too.

**Git is bridge-managed.** Do NOT run `git checkout`, `git commit`, or `git push` yourself — the bridge's lifecycle hook handles branch setup before your spawn and (if the app is configured for it) auto-commit + auto-push after a clean exit. Just write the code and exit; the bridge moves the bytes. The `## Changed files` section above is enough audit trail.
