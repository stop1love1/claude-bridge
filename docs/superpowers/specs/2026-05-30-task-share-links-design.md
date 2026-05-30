# Task Share Links — Design Spec

**Date:** 2026-05-30
**Status:** Approved (operator delegated open decisions to the implementer)

## Goal

Let an operator share a **single task** via a link. A guest opens the link,
the operator sees an **Approve** button, and once approved the guest can view
and operate on **that one task** — without logging in. Per-share config controls
what the guest may do (send prompts, answer permission popups, commit, push) and
which branch the guest's work lands on.

## Locked decisions

- **Approval model:** per **device**, one-time. Operator approves a device once;
  it's remembered for an operator-set TTL (or until revoked). Re-visits within
  the TTL skip approval.
- **Guest capabilities (per-share, all opt-in):** view task + live agent output
  (baseline), send prompts/messages, answer permission popups, commit & push.
- **Branch:** configured at share-create time — `branchMode`
  (`current` | `fixed` | `auto-create`) + optional branch name. Applied to
  guest-driven commits/spawns instead of the app's own git policy.
- **Link lifecycle:** persisted to disk (survives restart), revocable, optional
  expiry TTL.
- **Enforcement:** hybrid **deny-by-default allowlist** (approach C). The proxy
  authorizes a guest cookie ONLY for an explicit set of API paths bound to the
  share's `taskId`; everything else falls through to the normal reject path.
- **Authz freshness:** the guest cookie proves identity only (`shareId` +
  `deviceId`). Grants, revocation, and expiry are read **fresh from the store on
  every request**, so revoke / grant-changes take effect immediately.
- **Cookie:** reuse `bridge_session` with a `kind: "guest"` discriminator.
  Operator payloads are unchanged (absent `kind` = operator).
- **Link format:** `/<base>/share/<shareId>/<token>` — `shareId` for O(1)
  lookup, `token` (≥128-bit) verified constant-time against a stored SHA-256
  hash. The `/share/*` page is public (added to the proxy matcher exclusions).

## Data model — `libs/shareStore.ts` (persist `.bridge-state/shares.json`)

```ts
interface Share {
  id: string;                 // "shr_<hex>"
  tokenHash: string;          // sha256(token), hex
  taskId: string;
  label?: string;
  grants: {
    sendMessage: boolean;     // send prompts / spawn agents
    answerPermission: boolean;// answer Allow/Deny popups
    commit: boolean;
    push: boolean;            // implies commit
  };
  git: {
    branchMode: "current" | "fixed" | "auto-create";
    branchName?: string;      // for "fixed"
    autoCommit: boolean;
    autoPush: boolean;
  };
  deviceTtlMs: number | null; // null = remember until revoked
  expiresAt: number | null;   // share-level hard expiry (epoch ms)
  revoked: boolean;
  createdAt: string;          // ISO
  devices: GuestDevice[];     // approved devices
}

interface GuestDevice {
  did: string;                // "gdv_<hex>"
  label: string;              // guest display name / derived from UA
  ip: string;
  approvedAt: string;         // ISO
  expiresAt: number | null;   // approvedAt + share.deviceTtlMs (null = forever)
}
```

View (read-only) is always allowed for an approved device — it's the baseline,
not a toggle. Grants gate the write operations only.

## Pending requests — `libs/shareApprovals.ts` (in-RAM, ~3 min TTL)

Mirrors `libs/loginApprovals.ts`. A guest contact with no valid device grant
creates a `PendingShareRequest { id, shareId, taskId, did (candidate),
displayName, ip, userAgent, createdAt, expiresAt, status }`. Operator answers;
on approve the candidate `did` is written into `share.devices` and the guest's
next poll receives the signed guest cookie. Ephemeral by design — a pending
request needn't survive a restart.

## Auth — `libs/auth.ts`

- Extend `SessionPayload` with optional `kind?: "operator" | "guest"`,
  `sid?: string` (shareId), `tid?: string` (taskId). Guest payload: `sub:
  "guest"`, `kind: "guest"`, `sid`, `tid`, `did`, `exp`. `signSession` /
  `verifySession` are unchanged (sub+exp still present).
- New `verifyRequestActor(req): Operator | Guest | null` — resolves a request to
  an operator (existing cookie/internal) or a guest (validated against the live
  store: share exists, not revoked/expired, device present & unexpired).

## Enforcement — `libs/guestAccess.ts` + `proxy.ts`

`authorizeGuestRequest(method, pathname, guest): { ok: boolean; reason?: string }`
— pure, deny-by-default, fully unit-tested. Allowed (bound to `guest.tid`):

| Method | Path | Gate |
|---|---|---|
| GET | `/api/tasks/<tid>/meta\|events\|summary\|usage` | view |
| GET | `/api/tasks/<tid>/runs/<sid>/diff` | view |
| GET | `/api/sessions/<sid>/tail` + `/tail/stream` + `/permission` + `/permission/stream` | view + session∈task |
| POST | `/api/tasks/<tid>/agents` | sendMessage |
| POST | `/api/tasks/<tid>/runs/<sid>/prompt` | sendMessage |
| POST | `/api/sessions/<sid>/message` | sendMessage + session∈task |
| POST | `/api/sessions/<sid>/permission/<reqId>` | answerPermission + session∈task |
| POST | `/api/tasks/<tid>/runs/<sid>/commit` | commit (push only if `push`) |

`session∈task` is verified via a store lookup (the task's `meta.json` runs).
Everything not listed → `{ ok: false }` → proxy falls through to `rejectAuth`.
The guest's own access endpoints live under `/api/share/access/*`, which the
proxy matcher excludes (public), so they don't need guest-cookie authz.

The proxy, on a `kind: "guest"` payload, calls `verifyRequestActor`-style store
checks + `authorizeGuestRequest`; pass → `next()`, fail → reject.

## API routes

**Operator (cookie-gated by proxy):**
- `GET /api/share?taskId=` — list shares (optionally for one task).
- `POST /api/share` — create `{taskId, grants, git, deviceTtlMs, expiresAt?, label?}` → `{share, url}`.
- `GET|PATCH|DELETE /api/share/<id>` — read / update grants·git·ttl·revoked / revoke.
- `GET /api/share/requests` — pending guest requests (for the header modal).
- `POST /api/share/requests/<reqId>` — `{decision}`; approve writes the device + sets `expiresAt`.

**Guest (public, matcher-excluded `/api/share/access/*`):**
- `POST /api/share/access/<id>` — `{token, name?}`. Valid existing guest cookie → re-mint + `{status:"approved", taskId}`. Else create pending → `{status:"pending", requestId}`.
- `GET /api/share/access/<id>/pending/<reqId>` — guest poll; on approval the response **sets the guest cookie** and returns `{status:"approved", taskId}`.

Rate-limit all `/api/share/*` by IP.

## Git override

When the actor is a guest, `/api/tasks/<tid>/agents` and `.../commit` read
`share.git` (branchMode / branchName / autoCommit / autoPush) instead of the
app's settings, and refuse push unless `grants.push`. Implemented via a
`getGuestActor(req)` lookup in those two routes.

## UI

- **`ShareTaskDialog`** (from TaskDetail): create/edit/revoke shares, toggle
  grants, set git + TTL, copy link, list approved devices (revoke each).
- **`/share/<id>/<token>` guest page**: public shell. On load POSTs to the
  access endpoint; shows "waiting for approval" while pending, then renders a
  **stripped task view** (no global nav) — reusing the existing task log / agent
  tree / composer components, with a "Guest · <capabilities>" badge. Disabled
  controls for un-granted actions.
- **Header approvals**: the existing approvals poll/modal also surfaces share
  requests (display name + IP + UA + requested grants), with Approve / Deny.

## Security

- Token ≥128-bit, stored hashed (SHA-256), constant-time compared.
- Revoke / expiry checked against the store on **every** request (instant).
- Guest `did` must be present & unexpired in `share.devices` (revocable like a
  trusted device).
- Rate-limit `/api/share/*`; scrub errors via `safeErrorMessage`.
- Demo mode: `/api/share/*` returns 503 like the rest of the dashboard API.
- The guest never receives an operator cookie and is structurally confined to
  one `taskId` by the deny-by-default allowlist.

## Tests

- `shareStore`: create / lookup-by-id / token hash compare / device add / TTL +
  share expiry / revoke / atomic persistence.
- `shareApprovals`: create / answer / expire / consume.
- `guestAccess.authorizeGuestRequest`: deny-by-default, each allowed route, each
  grant gate, wrong-task rejection, method mismatch, session∈task.
- `auth.verifyRequestActor`: operator vs guest vs revoked/expired/unknown-device.
- Proxy integration: guest cookie scoped correctly; operator unaffected.
```
```

## Out of scope (YAGNI for v1)

- Max concurrent devices / max uses per share.
- Guest chat identity beyond a display name.
- Multi-task shares (one share = one task).
- Editing arbitrary files / running exec as a guest (never allowed).
