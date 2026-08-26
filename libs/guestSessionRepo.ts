/**
 * Shared by `POST /api/sessions/:sid/message` and `GET /api/sessions/
 * :sid/tail(/stream)`. Both routes accept a caller-supplied repo
 * identifier (a repo *name* for /message's `body.repo`, an absolute
 * project-dir *path* for /tail's `?repo=`) that decides where a message
 * spawns a fresh `claude` process, or which project directory a
 * transcript read comes from.
 *
 * `libs/guestAccess.ts`'s `checkSession: true` on both routes only
 * proves the sessionId is a run of the guest's OWN task — it says
 * nothing about which repo that run lives in. Trusting the caller's
 * value therefore reopened the exact escape task 6 closed on the agents
 * route (audit C4), just through two different doors: /message can
 * spawn a brand-new agent in any registered app via its weaker
 * `sendMessage` grant and no plan-gate, and /tail can then read the
 * transcript back by pointing `?repo=` at that other app.
 *
 * The fix: for a guest, discard the caller-supplied value outright and
 * use the value recorded on the session's OWN run instead — not merely
 * validate the caller's value against it, since a guest has no
 * legitimate reason to ever supply a different one. An operator can
 * message/tail "free chat" sessions with no owning task/run at all, so
 * their existing caller-value-driven behaviour is preserved unchanged.
 */
export function guestBoundRepoValue(args: {
  actorKind: "guest" | "operator";
  callerValue: string | null;
  sessionValue: string | null;
}): string | null {
  if (args.actorKind !== "guest") return args.callerValue;
  return args.sessionValue;
}
