import { GuestTaskClient } from "@/app/_components/GuestTaskClient";

export const dynamic = "force-dynamic";

export default async function SharePage({
  params,
}: {
  params: Promise<{ id: string; token: string }>;
}) {
  const { id, token } = await params;
  return <GuestTaskClient shareId={id} token={token} />;
}
