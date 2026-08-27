interface HeadersLike {
  get(name: string): string | null;
}

const TRUSTED = process.env.BRIDGE_TRUSTED_PROXY === "1";

export function getClientIp(headers: HeadersLike): string {
  if (TRUSTED) {
    const xff = headers.get("x-forwarded-for");
    if (xff) {
      const first = xff.split(",")[0]?.trim();
      if (first) return first;
    }
    const real = headers.get("x-real-ip");
    if (real && real.trim()) return real.trim();
  }
  return "unknown";
}
