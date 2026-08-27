"use client";

import { use } from "react";
import { AppDetail } from "@/app/_components/AppDetail";

export default function AppDetailRoute({ params }: { params: Promise<{ name: string }> }) {
  const { name } = use(params);
  return <AppDetail name={decodeURIComponent(name)} />;
}
