export function guestBoundRepoValue(args: {
  actorKind: "guest" | "operator";
  callerValue: string | null;
  sessionValue: string | null;
}): string | null {
  if (args.actorKind !== "guest") return args.callerValue;
  return args.sessionValue;
}
