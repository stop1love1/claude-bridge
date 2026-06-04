# Live App Preview (Epic C) — Design

- **Date:** 2026-06-04
- **Status:** Approved direction (operator: "toàn bộ"); details delegated to Claude.
- **Epic:** C of the roadmap. Lets contributors watch the running app while they drive it.
- **Owner repo:** `claude-bridge`.

## Problem

A guest can type a prompt and an agent ships code, but the guest can't *see* the running app
— they get the transcript, not the UI. The original vision: "người ngoài … xem được trực
tiếp giao diện thông qua proxy."

## Goal

Embed the running app's UI as a live `iframe` in the task detail (operator) and the share
page (guest, gated by a new `viewPreview` grant). The operator sets a reachable preview URL
per app (localhost for local use, or a public tunnel/staging URL for remote guests — the
bridge already ships one-click tunnels for the latter). MVP scope: the bridge stores +
embeds the URL; it does not itself reverse-proxy the dev server (noted as a future
enhancement).

## Architecture

Self-contained store, no changes to the `App` registry / `bridge.json`.

### Components

**New**
- `libs/previewStore.ts` — `.bridge-state/previews.json`, a `{ [appName]: { url } }` map.
  `getPreviewUrl(app)`, `setPreviewUrl(app, url)`, `listPreviews()`. Validates the URL is
  `http(s)://…`; stores `null`/clears on empty. Same globalThis + atomic-write pattern.
- `app/api/tasks/[id]/preview/route.ts` — `GET` resolves the task's primary app
  (`meta.taskApp` → else the first run's `repo`) and returns `{ app, url }`. `PUT` sets it
  (operator only — guests get 403). CSRF on PUT.
- `app/_components/LivePreview.tsx` — the iframe panel: when a `url` exists, an `<iframe>` +
  "Open in new tab" + "Reload"; for the operator, an inline URL input to set/update it; for
  a guest, read-only (or an empty-state note when unset).

**Modified**
- `libs/shareStore.ts` — add `viewPreview` grant (default false; same plumbing as
  `approvePlan`).
- `libs/guestAccess.ts` — allowlist `GET /api/tasks/:tid/preview` behind `viewPreview`.
- `app/_components/ShareTaskDialog.tsx`, `GuestTaskClient.tsx` — `viewPreview` checkbox +
  grant label.
- Operator task page (`TaskDetail`) — render `<LivePreview taskId mode="operator" />`.
- Guest share page (`GuestTaskClient`) — render `<LivePreview taskId mode="guest"
  canView={grants.viewPreview} />`.
- `libs/client/api.ts` — `taskPreview(id)` / `updateTaskPreview(id, url)`.

### Resolve logic

`GET /api/tasks/:id/preview` → primary app = `meta.taskApp` if set, else the `repo` of the
first non-coordinator run, else null. Look up `getPreviewUrl(app)`. Returns `{ app, url }`
(url null when unset). Guests only see the URL when the share grants `viewPreview`.

### Embedding notes

- Same-origin localhost works for the local operator. For remote guests the operator
  supplies a publicly reachable URL (their localtunnel/ngrok or staging). Some hosts send
  `X-Frame-Options: DENY` / `frame-ancestors` and won't embed — the panel always offers an
  "Open in new tab" fallback, and shows a hint when the frame fails to load.
- The iframe is `sandbox`ed (`allow-scripts allow-forms allow-same-origin allow-popups`) and
  `referrerPolicy="no-referrer"`. No bridge cookies are exposed to the framed origin (it's a
  different origin).

## Security

- `viewPreview` defaults false; back-compat via `normalizeGrants` (like `approvePlan`).
- `PUT preview` is operator-only (not in the guest allowlist) — a guest can never change the
  URL, only view it (with the grant).
- URL validation: only `http://` / `https://` accepted; anything else rejected (prevents
  `javascript:` / `data:` iframe injection).

## Testing (vitest)

- `previewStore.test.ts` — set/get/clear; rejects non-http(s) URLs; snapshot/restore the
  real `.bridge-state` file.
- `shareStore` — `viewPreview` normalization back-compat (fold into the existing share test).
- `guestAccess` — `GET preview` allowed with `viewPreview`, denied without (fold into the
  plan test or a new one).

## Acceptance criteria

1. Operator sets a preview URL on a task; the task detail shows the app in an iframe.
2. A share with `viewPreview` shows the same iframe to the guest; without it, the guest sees
   a "preview not shared" note and cannot read the URL.
3. Non-http(s) URLs are rejected.
4. "Open in new tab" works regardless of framing restrictions.
5. All suites + typecheck + lint clean.

## Out of scope

- Bridge reverse-proxying the dev server under its own origin (future — solves embedding +
  reachability without a separate public app URL).
- Auto-starting the app's dev server / auto-detecting its port.
- One-click "expose this app via tunnel" wired into preview (operator uses the existing
  `/tunnels` UI and pastes the URL for now).
