"use client";

import { use } from "react";
import { AppDetail } from "@/app/_components/AppDetail";

/**
 * App detail page. The route's `[name]` segment is usually
 * `encodeURIComponent(app.path)` so duplicate display names still
 * resolve to the correct folder; legacy slug URLs work when unique.
 * The page itself is a thin wrapper
 * around `<AppDetail>` so the heavy lifting lives in a client
 * component that can use hooks + state freely.
 *
 * `params` is a Promise in Next 15+; `use()` unwraps it without
 * blocking the suspense boundary the parent already provides.
 */
export default function AppDetailRoute({ params }: { params: Promise<{ name: string }> }) {
  const { name } = use(params);
  return <AppDetail name={decodeURIComponent(name)} />;
}
