"use client";

import Image from "next/image";
import Link from "next/link";
import { MainNav, type MainNavSection } from "./MainNav";

/**
 * The brand + nav block that every top-level page renders identically.
 * Pages append their own controls (search box, filters, "New X" button,
 * status pills) as children — those live INSIDE the same `<header>` so
 * the layout stays a single 11-tall row.
 */
export function HeaderShell({
  active,
  badges,
  children,
}: {
  active: MainNavSection;
  badges?: Partial<Record<MainNavSection, React.ReactNode>>;
  children?: React.ReactNode;
}) {
  return (
    <header className="h-11 shrink-0 px-3 border-b border-border bg-card flex items-center gap-3">
      <Link href="/" className="flex items-center gap-2 shrink-0" title="Home">
        <Image
          src="/logo.svg"
          alt="Claude Bridge"
          width={20}
          height={20}
          className="rounded-sm"
          priority
        />
        <h1 className="text-sm font-semibold">Claude Bridge</h1>
      </Link>
      <MainNav active={active} badges={badges} />
      {children}
    </header>
  );
}
