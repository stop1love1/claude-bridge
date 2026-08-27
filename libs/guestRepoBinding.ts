export function guestMayTargetRepo(args: {
  actorKind: "guest" | "operator";
  repo: string;
  taskApp: string | null;
}): boolean {
  if (args.actorKind !== "guest") return true;
  if (!args.taskApp) return false;
  return args.repo === args.taskApp;
}
