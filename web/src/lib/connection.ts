// Lightweight wrapper around the existing `useHealth` query that
// collapses fetch state into the three concrete states the header
// chrome needs to render: ok / auth / offline.
//
// "auth"   — server reachable but rejected our token (401)
// "offline"— fetch threw or non-OK response that wasn't 401
// "ok"     — /api/health returned `{ status: "ok" }`
//
// Refetch every 10s so a server restart shows up promptly without
// hammering the loopback.
import { useHealth } from "@/api/queries";

export type ConnectionState = "ok" | "auth" | "offline";

export interface Connection {
  state: ConnectionState;
  version?: string;
  uptime?: number;
}

export function useConnection(): Connection {
  const { data, isError, error } = useHealth(10_000);
  if (data?.status === "ok") {
    return { state: "ok", version: data.version, uptime: data.uptime };
  }
  // The api client throws a typed ApiError with a `status` field.
  const status = (error as { status?: number } | undefined)?.status;
  if (status === 401) return { state: "auth" };
  if (isError) return { state: "offline" };
  // Initial / refetching with no data yet — treat as offline visually.
  return { state: "offline" };
}
