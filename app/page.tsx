import { redirect } from "next/navigation";

/**
 * `/` is now an alias for `/apps` — the apps registry is the entry
 * point users see first. Tasks live at `/tasks`, Sessions at
 * `/sessions`. Keeping `/` as a redirect (rather than mounting Apps
 * directly here) means there's only one route that owns the page so
 * deep links / browser history stay stable.
 */
export default function HomeRedirect() {
  redirect("/apps");
}
