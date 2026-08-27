import type { App } from "./types";

export function appDetailRouteSegment(app: Pick<App, "path">): string {
  return encodeURIComponent(app.path);
}
