import { GuestTaskClient } from "@/app/_components/GuestTaskClient";

export const dynamic = "force-dynamic";

/**
 * Public guest landing page for a shared task: `/share/<id>/<token>`.
 *
 * This route is excluded from the proxy matcher, so it renders without a
 * cookie. The client component runs the access handshake against the
 * public `/api/share/access/*` endpoints; only after the operator
 * approves does it receive a scoped guest cookie and render the task.
 */
export default async function SharePage({
  params,
}: {
  params: Promise<{ id: string; token: string }>;
}) {
  const { id, token } = await params;
  return <GuestTaskClient shareId={id} token={token} />;
}
