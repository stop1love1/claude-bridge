// Tiny class-name concat helper. Not a full clsx — just enough to drop
// strings/booleans into JSX without pulling in a dependency.
export function cn(
  ...parts: Array<string | false | null | undefined>
): string {
  return parts.filter(Boolean).join(" ");
}
