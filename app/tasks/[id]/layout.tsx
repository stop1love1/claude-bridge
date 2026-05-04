import type { Metadata } from "next";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  return { title: `Task ${id}` };
}

export default function TaskLayout({ children }: { children: React.ReactNode }) {
  return children;
}
