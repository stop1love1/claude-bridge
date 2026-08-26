/**
 * A task-share guest may only ever drive agents in the app their task is
 * pinned to. The guest allowlist (libs/guestAccess.ts) matches on URL,
 * method and grant only — it never sees the request body, so `body.repo`
 * reached resolveRepoCwd unchecked and resolved ANY registered app
 * (audit C4). An unpinned task gives no bound, so it denies.
 */
export function guestMayTargetRepo(args: {
  actorKind: "guest" | "operator";
  repo: string;
  taskApp: string | null;
}): boolean {
  if (args.actorKind !== "guest") return true;
  if (!args.taskApp) return false;
  return args.repo === args.taskApp;
}
