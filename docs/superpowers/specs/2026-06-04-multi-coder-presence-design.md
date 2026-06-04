# Multi-coder Presence (Epic D) — Design

- **Date:** 2026-06-04
- **Status:** Approved direction (operator: "toàn bộ"); details delegated to Claude.
- **Epic:** D of the roadmap (final). Coordinate multiple contributors on one task.
- **Owner repo:** `claude-bridge`.

## Problem

Multiple people (operator + guests) can drive the same task. With no signal of who else is
present, they talk over each other and re-issue overlapping prompts — "giẫm chân nhau."

## Goal

Coordinate-via-visibility: show **who is currently present on a task** (operator + named
guests), live, on both the operator task page and the guest share page. Contributors see
each other and self-coordinate. The bridge already queues mid-turn prompts
(`libs/messageQueue.ts`); D adds the missing *presence* signal. Hard per-contributor branch
isolation is out of scope for v1 (the share's existing `branchMode` already lets the operator
scope guest work to a branch).

## Architecture

A lightweight, TTL-based presence store updated by client heartbeats. No persistence needed —
presence is ephemeral (lost on restart, which is correct).

### Components

**New**
- `libs/presenceStore.ts` — in-memory (globalThis) map `taskId → participant[]`, each
  `{ id, label, kind: "operator"|"guest", lastSeen: number }`. `touchPresence(taskId, p)`
  upserts by `id` + stamps `lastSeen`; `listActive(taskId, now?)` returns participants seen
  within `PRESENCE_TTL_MS` (20s) and sweeps stale ones. Same globalThis + `Date.now()`
  pattern as `libs/heartbeat.ts`.
- `app/api/tasks/[id]/presence/route.ts` — `POST` heartbeat: derives identity from
  `verifyRequestActor` (operator → `{id:"operator"}`; guest → `{id: did}`), takes an optional
  display `label` from the body, calls `touchPresence`, returns the active list. `GET`
  returns the active list. Both are cheap + rate-limit-friendly.
- `app/_components/PresenceBadge.tsx` — "👥 N" chip + a tooltip/popover listing names; sends
  a heartbeat every 8s and refreshes the list. Used on the operator task page header and the
  guest share header.

**Modified**
- `libs/guestAccess.ts` — allowlist `GET` + `POST /api/tasks/:tid/presence` (grant `null` —
  any task viewer participates in presence).
- `app/tasks/[id]/page.tsx` (operator header) + `app/_components/GuestTaskClient.tsx` (share
  header) — render `<PresenceBadge>`.
- `libs/client/api.ts` — `taskPresence(id)` / `pingPresence(id, label)`.

### Identity + labels

- Operator: a single `{ id: "operator", label: "Operator", kind: "operator" }`.
- Guest: `{ id: did, label, kind: "guest" }` where `label` is the name the guest entered on
  the share gate (the share page already stores it in `localStorage` under `bridge_guest_name`),
  falling back to a short `did`-derived label.

### Flow

```
client mounts on a task → POST /presence {label} every 8s (heartbeat)
                        → renders the returned active list ("👥 3 — Operator, Alice, Bob")
server: touchPresence upserts by id + stamps lastSeen; listActive drops anyone > 20s stale
```

Polling at 8s (heartbeat) doubles as the refresh — no separate GET needed in steady state,
though `GET` exists for an initial paint and for non-heartbeating readers.

## Security

- Presence is task-scoped; guests only touch their own task (guestAccess binds `:tid` to the
  share's task). Identity is server-derived (`verifyRequestActor`), so a guest can't
  impersonate the operator or another did — the body's `label` is display-only and length-capped.
- No new grant: presence is part of the view baseline (a guest who can see the task can see
  who else is on it). Labels are sanitized (cap 40 chars, strip control chars).

## Testing (vitest)

- `presenceStore.test.ts` — upsert by id (no dupes); `listActive` filters by TTL; stale
  sweep; multiple participants; operator + guest coexist.

## Acceptance criteria

1. Two browsers on the same task each show "👥 2" with both names within ~10s.
2. Closing one browser drops the count within ~20s (TTL).
3. A guest's heartbeat is attributed to their entered name; the operator shows as "Operator".
4. Guests can't impersonate another identity (server-derived id).
5. All suites + typecheck + lint clean.

## Out of scope

- Hard per-contributor branch/worktree isolation (use the share's `branchMode`).
- "Who is currently driving / typing" indicator + soft locks (presence-only for v1).
- Persisted presence history.
