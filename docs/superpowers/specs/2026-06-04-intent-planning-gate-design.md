# Intent & Planning Gate — Design

- **Date:** 2026-06-04
- **Status:** Approved (architecture + policy by operator; remaining details decided by Claude on delegation "tự quyết định đi")
- **Epic:** A of the "team agentic workspace" roadmap (A. Intent & Planning Gate → B. Reliability Amplifier → C. Live Preview via proxy → D. Multi-coder Coordination)
- **Owner repo:** `claude-bridge` (this repo — no sibling-app code changes)

## Problem

External contributors reach a task through an operator-approved share link, type a
prompt, and the bridge spawns coding agents. Loose, under-specified prompts (the common
case for someone unfamiliar with the codebase) make agents code in the wrong direction
before anyone can course-correct. The bridge already has a `planner` role, a
`NEEDS-DECISION` escalation contract, and per-share grants — but planning is **optional
and coordinator-discretionary**, and prompts arriving via `POST /api/tasks/:id/agents`
bypass the coordinator entirely. There is no enforced "understand → clarify → plan →
approve → then code" gate.

## Goal

Insert a **bridge-enforced gate** between "a prompt arrives" and "a mutating agent runs".
The gate always produces a short plan, pauses to ask only when the request is genuinely
ambiguous, and routes plan approval to the right person based on share grants. Enforcement
lives in **code** (not prompts) so it survives coordinator prompt-drift and covers the
guest `/agents` path.

## Policy (locked with operator)

- **Applies to:** both operator and guests, **configurable**. Guests **always** pass
  through the gate (non-negotiable safety contract). The operator gate is a toggle
  (default ON, "smart" mode).
- **When it pauses:** *smart by ambiguity*. Intake **always** produces a short plan, but
  only **pauses to ask** when the planner returns `NEEDS-DECISION`. A clear plan proceeds
  without a forced approval wait — **for an approver who can self-approve**.
- **Who approves:** the operator always can. A guest can approve **only** with a new
  `approvePlan` share grant. A guest **without** `approvePlan` has *every* plan (even a
  clear one) held for operator approval — this is the safety net for untrusted external
  contributions.

Reconciled truth table for the **approval pause** (orthogonal to the *clarification* pause,
which fires on `NEEDS-DECISION` regardless of actor):

| Submitter | Plan verdict | Can self-approve? | Result |
|---|---|---|---|
| Operator (gate on) | clear | yes | auto-approve → code proceeds |
| Operator (gate on) | needs-decision | yes | await operator answers, then approve |
| Operator (gate off) | — | — | gate inert (`intake.status = none`), legacy behavior |
| Guest + `approvePlan` | clear | yes | auto-approve → code proceeds |
| Guest + `approvePlan` | needs-decision | yes | guest answers + approves |
| Guest, no `approvePlan` | clear | no | await operator approval |
| Guest, no `approvePlan` | needs-decision | no | await operator answers + approval |

## Architecture — Hybrid (chosen over prompt-only and full-stage alternatives)

Bridge owns a hard gate flag; the *thinking* reuses the existing `planner` role; the
*approval* is a server-side endpoint checking actor + grant.

### Gate state machine

A new `intake` sub-state on the task (orthogonal to the existing TODO/DOING/BLOCKED
sections — no new board column; render as a badge + reuse the coordinator's existing
`AWAITING DECISION` summary top-line):

```
intake.status:
  none              gate off → unchanged legacy behavior
  planning          planner running, producing plan + verdict        [badge 🧭 Đang lập kế hoạch]
  awaiting-approval plan ready, waiting on approve / answers          [badge ⏳ Chờ duyệt plan; summary AWAITING DECISION]
  approved          mutating roles may run
  error             planner crashed / unparseable → operator escape hatch
```

Transitions:

```
[prompt in] → planning
   planner done, verdict=clear,  approver auto-eligible  → approved → [coder runs]
   planner done, verdict=clear,  guest w/o approvePlan   → awaiting-approval (operator)
   planner done, verdict=needs-decision                  → awaiting-approval (show questions)
   approver answers + approves                            → approved
   approver requests changes (re-plan)                    → planning (planner refines plan.md)
   planner crash / N rounds exceeded                      → error (operator: retry | force-approve | skip)
```

### Enforcement point

Pure function `evaluatePlanGate({ meta, role, actor, config })` in **`libs/planGate.ts`**,
called at the **top** of `POST /api/tasks/:id/agents`:

- **Gate applicability is per-actor**, recomputed on every call (not just read from
  status): `gateApplies = config.operatorEnabled || actor.kind === "guest"`. A guest
  always triggers the gate even on a task the operator left at `intake.status = none`
  (operator-disabled) — guests can never inherit "gate off".
- **Non-mutating roles** (`planner`, `reviewer`, `ui-tester`, `semantic-verifier`,
  `style-critic`, `devops`) → always allowed (the gate must be able to *run* the planner;
  read-only roles can't write wrong code; `devops` only runs post-success on already-gated
  output). Encoded as `isMutatingRole(role)`.
- **Mutating roles** (`coder`, `fixer`, and any role not on the safe allowlist) → allowed
  only when `gateApplies === false` **or** `intake.status === "approved"`. Otherwise the
  route returns **HTTP 423 Locked** with `{ error: "plan-gate", intakeStatus, reason }`,
  and — if no intake is underway (`none` / absent) — flips `intake.status = planning` and
  kicks off the `planner` with the blocked brief as the planning input.

Because the check is in the route, it covers **both** entry paths and is immune to
coordinator prompt-drift.

### Components

**New files**
- `libs/planGate.ts` — pure logic, no I/O: `evaluatePlanGate()`, `isMutatingRole()`,
  `deriveGateVerdict(report, planMd)` (maps a planner report → `clear | needs-decision`,
  with a fallback that parses `## Questions for the user` from `plan.md`), `canApprove(actor)`.
- `libs/planGateConfig.ts` — tiny store over `.bridge-state/plan-gate.json`
  (`{ operatorEnabled: boolean, maxClarifyRounds: number }`, defaults `true` / `3`),
  mirroring the `shareStore` globalThis + atomic-write pattern.
- `app/api/tasks/[id]/plan/route.ts` — `GET` current plan + intake projection (operator
  and authorized guests).
- `app/api/tasks/[id]/plan/approve/route.ts` — `POST` approve / request-changes / reject:
  verifies actor + `approvePlan`, validates + stores `answers`, flips status, triggers
  continuation.

**Modified files**
- `libs/meta.ts` — add the `intake` field to the task meta type + `readIntake` /
  `setIntake` helpers. Migration-aware: meta written before this feature has no `intake`
  → treated as `none`.
- `libs/shareStore.ts` — add `approvePlan: boolean` to `ShareGrants`; `normalizeGrants`
  back-compat (`undefined → false`); include in `ShareView`.
- `libs/guestAccess.ts` — allowlist rules: `GET /api/tasks/:tid/plan` (any guest of the
  task), `POST /api/tasks/:tid/plan/approve` (requires `approvePlan`).
- `app/api/tasks/[id]/agents/route.ts` — call `evaluatePlanGate()` first; 423 + auto-kick
  planner for blocked mutating roles.
- `app/api/tasks/route.ts` — on task creation: if the gate applies, set
  `intake.status = planning` and dispatch the **`planner` first** (not the coordinator).
  The coordinator is dispatched **after approval** (by the `approve` endpoint), so it
  enters with an approved plan already injected and its coder spawns pass the gate
  immediately. If the gate does not apply (operator off, operator-created task), behavior
  is unchanged: dispatch the coordinator directly with `intake.status = none`.
- `prompts/playbooks/planner.md` — when the bridge injects a `## Intake gate` block,
  the planner additionally writes `sessions/<id>/intake.json` (fixed schema below). The
  derive step falls back to parsing `plan.md` if the JSON is absent/corrupt.
- `prompts/coordinator.md` + `prompts/coordinator-playbook.md` — directive: spawn `planner`
  first; do not dispatch mutating roles until the bridge reports the gate approved (the
  bridge enforces this in parallel — the prompt change is for cooperative behavior + good
  error messages, not the security boundary).
- `app/tasks/[id]/*` and `app/share/[id]/[token]/page.tsx` — plan-review UI (below).
- `app/settings` — operator toggle for the gate.

### `intake.json` schema (planner output, gate input)

```jsonc
{
  "version": 1,
  "verdict": "clear" | "needs-decision",
  "summary": "1-2 sentence restatement of the understood goal",
  "questions": [
    { "id": "q1", "text": "...", "options": ["A", "B"], "recommended": "A" }
  ],            // [] when clear
  "planPath": "plan.md"
}
```

### Data flow (unified across both entry paths)

```
1. Prompt arrives (task create OR guest POST that needs a mutating role)
2. Gate applies?  (config.operatorEnabled || actor.kind === "guest")
        └─ no → intake.status = none → legacy behavior, nothing else changes
3. intake.status = planning → bridge spawns `planner` (brief = prompt + ## Intake gate)
4. planner writes plan.md + intake.json {verdict, questions}
5. on planner exit, runLifecycle calls deriveGateVerdict():
     clear  & approver auto-eligible → approved (auto)
     clear  & guest w/o grant         → awaiting-approval (operator)
     needs-decision                   → awaiting-approval (questions surfaced)
6. approver opens plan, answers questions if any, clicks Approve
     → approved (+answers appended into plan.md so downstream coders see them)
     → or Request changes → planning (planner refines)
7. on reaching `approved` (auto or manual), the bridge dispatches the coordinator with the
   plan injected; its mutating /agents calls now pass the gate → code → existing
   verify-then-ship chain. (For the guest direct-/agents path, the originally blocked
   mutating spawn is what the contributor re-issues — or the coordinator owns it.)
```

Answers + plan ride the existing `loadSharedPlan` injection into every downstream coder —
no new context channel.

## Security & grants

- New grant `approvePlan` (default `false`). Push-implies-commit style normalization keeps
  it independent; old shares deserialize to `false`.
- `canApprove(actor)`: operator → always; guest → `actor.grants.approvePlan === true`.
- The **gate config toggle is operator-only** — never in the guest allowlist, so a guest
  can never disable their own gate.
- `POST plan/approve` and `POST plan` (changes/reject) are mutating → CSRF check +
  per-IP rate limit, consistent with `agents` / `commit` routes.
- Approval is **idempotent**: approving an already-`approved` task returns 200 no-op.
- Audit: `intake.approvedBy = { kind, label, at }` plus a line in the task run log.
- Guest work continues to inherit `effectiveGitForActor` (no protected-branch landing,
  no PR on the operator's behalf) — unchanged by this epic.

## UI

**Operator — `app/tasks/[id]`**: a "Plan review" card appears when `intake.status` is
`planning | awaiting-approval | error`.
- `planning` → spinner "Đang lập kế hoạch…".
- `awaiting-approval` → render `plan.md` (react-markdown, already a dep) + a questions form
  (radio/options + free text) when present + buttons **[Duyệt & code]** **[Sửa hướng…]**
  (reopens planning with an operator note) **[Từ chối]**.
- `error` → message + **[Thử lại]** / **[Bỏ qua gate (force-approve)]** (operator-only).

**Guest — `app/share/[id]/[token]/page.tsx`**: same card. Buttons render only when
`approvePlan` is granted; otherwise read-only "Chờ chủ dự án duyệt kế hoạch."

**Board**: task card shows the 🧭 / ⏳ badge.

**Live updates**: reuse the existing task SSE (`app/api/tasks/[id]/events/route.ts`) to push
`intake` changes so both surfaces update without polling.

## Config

- Bridge-level toggle in `app/settings`: **Planning Gate** (operator on/off, default ON
  "smart") + `maxClarifyRounds` (default 3). Stored in `.bridge-state/plan-gate.json`.
- Per-share: `approvePlan` checkbox in the share create/edit dialog.
- Per-app override is **out of scope** for this epic (bridge-level only) — noted for a
  later iteration.

## Error handling & edge cases

- **Planner crash / non-zero exit** → `intake.status = error`; operator escape hatch
  (retry / force-approve / skip). Never silently blocks forever.
- **`intake.json` missing/corrupt** → fall back to parsing `plan.md` `## Questions`; if
  none found, treat as `clear` (fail-open to "operator approves") rather than hard-locking.
- **Re-plan loop bound** → after `maxClarifyRounds` clarification cycles, force
  `awaiting-approval` requiring an explicit operator decision (no infinite clarify).
- **Concurrent / double-click approval** → idempotent (see Security).
- **Coordinator mid-run hits 423** → playbook tells it to stop and wait; the
  `approve` endpoint re-triggers continuation via the existing
  `POST /api/tasks/:id/continue` path.
- **Speculative / worktree** → gate is evaluated *before* speculative fan-out; once
  approved, speculative proceeds unchanged.
- **DEMO_MODE** → inert (no agents run anyway).
- **Backward compatibility** → existing tasks have no `intake` field → `none` → unchanged.
  New tasks default to gate-on-smart; clear operator prompts run straight through, so
  added friction for the operator is near-zero.

## Testing (vitest, existing `libs/__tests__` style)

- `planGate.test.ts` — `evaluatePlanGate` truth table (role × `intake.status` × actor ×
  grant); `deriveGateVerdict` mapping incl. fallback parse; `isMutatingRole`; `canApprove`.
- `shareStore` — `approvePlan` normalization back-compat (old grants → false; explicit
  honored).
- `guestAccess` — authorize `GET plan` (any task guest) and `POST plan/approve` (allow with
  grant, deny without).
- `meta` — `intake` migration (legacy meta → `none`).
- `agents` route — gate-block: mutating role spawn while `planning` → 423; while
  `approved` → proceeds (spawn mocked).
- `planGateConfig` — defaults + round-trip persistence.

## Acceptance criteria

1. With the gate ON, a guest's mutating spawn for an unplanned task returns 423 and a
   planner is kicked automatically.
2. A `NEEDS-DECISION` plan surfaces questions to the correct approver and holds at
   `awaiting-approval`; answering + approving lets coding proceed with answers injected.
3. A clear operator prompt (gate on, smart) auto-approves and proceeds with no extra click.
4. A guest without `approvePlan` cannot approve; the plan waits for the operator.
5. Existing tasks and gate-off operator flows behave exactly as before (no regressions).
6. All new + existing vitest suites pass; `typecheck` and `lint` clean.

## Out of scope (later epics / iterations)

- Per-app gate overrides (bridge-level only here).
- Reliability Amplifier (multi-round self-review) — Epic B.
- Live preview via proxy — Epic C.
- Multi-coder presence / prompt queue / per-contributor isolation — Epic D.
- Reworking the planner's reasoning quality itself — this epic only *gates* on it.
```
