import type { App } from "./types";

/**
 * URL segment for `/apps/<segment>` and `/api/apps/<segment>/…`.
 * Uses resolved absolute `path` so two registry rows with the same
 * `name` still map to distinct routes.
 */
export function appDetailRouteSegment(app: Pick<App, "path">): string {
  return encodeURIComponent(app.path);
}
