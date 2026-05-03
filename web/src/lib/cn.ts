// shadcn-style class composer: clsx + tailwind-merge.
//
// We previously shipped a tiny string-only variant; the upgrade is
// drop-in compatible (clsx accepts everything the old signature did)
// and lets us safely splat conditional class objects from ported
// shadcn primitives without classes silently overriding each other.
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
