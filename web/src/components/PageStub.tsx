import { Construction } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * Placeholder for routes whose page implementations haven't landed
 * yet — the foundation agent ships the routing scaffold so other
 * agents can wire up Apps / Sessions / Tunnels / Usage independently
 * without merge conflicts.
 */
export function PageStub({ title }: { title: string }) {
  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-12">
      <h1 className="font-mono text-display font-semibold tracking-tightish text-fg mb-1">
        {title.toLowerCase()}
      </h1>
      <p className="mb-8 text-small text-muted">
        page scaffold — implementation pending
      </p>
      <EmptyState
        icon={Construction}
        title="under construction"
        hint={`the ${title.toLowerCase()} page hasn't shipped yet. the route is wired so deep links keep working — check back after the next migration milestone.`}
      />
    </div>
  );
}
