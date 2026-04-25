import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn-style class composer: clsx + tailwind-merge in one call. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
