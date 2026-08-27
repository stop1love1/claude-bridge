export const PEER_ADDR_HEADER = "x-bridge-peer-addr";

export const CLIENT_FORWARDED_FOR_HEADER = "x-bridge-client-xff";

export function normalizePeerAddr(addr: string): string {
  return addr.replace(/^::ffff:/i, "");
}

export interface StampableRequest {
  headers: Record<string, string | string[] | undefined>;
  socket: { remoteAddress?: string | null };
}

function firstHeaderValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export function stampServerAuthoredHeaders(req: StampableRequest): void {
  delete req.headers[PEER_ADDR_HEADER];
  const peer = req.socket.remoteAddress;
  if (peer) req.headers[PEER_ADDR_HEADER] = peer;

  delete req.headers[CLIENT_FORWARDED_FOR_HEADER];
  const clientXff = firstHeaderValue(req.headers["x-forwarded-for"]);
  if (clientXff) req.headers[CLIENT_FORWARDED_FOR_HEADER] = clientXff;
}
